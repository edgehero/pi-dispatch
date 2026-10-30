/** Host preparation for a human, outside every paid processor, budget and run-slot path (#771). */
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { ensureJobsDir, ensureSandboxDir, loadConfig } from "./config.mjs";
import { parseTriggers } from "./triggers.mjs";
import { makeImagePreflight, resolveJobImage } from "./image-preflight.mjs";
import { resolveBackendName } from "./backend-registry.mjs";
import { resolveJobSize } from "./job-size.mjs";
import { loadProjects, projectOf } from "./projects.mjs";
import { loadScopedLimits } from "./scoped-limits.mjs";
import { SANDBOX_MANIFEST, pinSandbox, readManifest, sandboxDeadline } from "./sandbox-store.mjs";
import { cloneHostWorkspace, isCloneRefGone } from "./host-clone.mjs";
import { parseSandboxRef, resolveSandboxRef, sandboxRemoteUrl, sandboxRepoProblem } from "./sandbox-refs.mjs";
import { sandboxManifestGeneration } from "./sandbox-inventory.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

export const PREPARED_SANDBOX_ID_RE = /^sb-[a-f0-9]{32}$/;
export const newSandboxId = () => `sb-${randomBytes(16).toString("hex")}`;
const PREPARATION_LOCK_MAX_BYTES = 16 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const refused = (reason, message) => ({ refused: reason, message });
const configRefusal = () => refused("sandbox-config-invalid", "the host's sandbox configuration could not be read; run pi-dispatch doctor on that host");

export function sandboxTriggerDigest(text, index) {
	const rows = JSON.parse(text)?.triggers;
	if (!Number.isInteger(index) || index < 0 || !Array.isArray(rows) || !rows[index]) throw new Error("choose an existing trigger index");
	return hash(JSON.stringify(rows[index]));
}

/** Console previews and worker decisions use the same pure resolution; the worker still re-reads its own files. */
export function planSandboxPreparation({ request, config, env = {}, triggersText, projects = [], limits = [] } = {}) {
	if (!request || typeof request.host !== "string" || !WORKER_NAME_RE.test(request.host) || request.host !== config?.workerName) return refused("sandbox-host-mismatch", "the selected host does not own this sandbox preparation");
	if (request.id !== undefined && !PREPARED_SANDBOX_ID_RE.test(request.id)) return refused("sandbox-id-invalid", "a prepared sandbox id must be sb- followed by 32 lowercase hexadecimal characters");
	if (request.pin !== undefined && typeof request.pin !== "boolean") return refused("sandbox-pin-invalid", "pin must be true or false");
	let triggers, raw, digest;
	try {
		triggers = parseTriggers(triggersText, config.triggersFile ?? "triggers.json");
		digest = sandboxTriggerDigest(triggersText, request.triggerIndex);
		raw = JSON.parse(triggersText).triggers[request.triggerIndex];
	} catch { return refused("sandbox-trigger-unavailable", "the selected trigger is missing or its file does not load; refresh the console or run pi-dispatch doctor"); }
	if (request.triggerDigest !== undefined && request.triggerDigest !== digest) return refused("sandbox-trigger-changed", "the selected trigger changed; preview the sandbox again");
	// A disarmed trigger remains valid configuration. Preparing its image does not arm or run it.
	const trigger = triggers[request.triggerIndex]?.on.type === "disarmed" ? raw : triggers[request.triggerIndex];
	const kind = trigger?.run?.kind;
	const repoProblem = sandboxRepoProblem(request.repo, kind);
	if (repoProblem) return refused("sandbox-repo-invalid", repoProblem);
	if (trigger.run.repository && request.repo.split("/").at(-1) !== trigger.run.repository) return refused("sandbox-repo-mismatch", "the repository does not match the selected trigger's repository");
	const parsedRef = parseSandboxRef(request.ref ?? "HEAD", kind);
	if (parsedRef.refused) return parsedRef;
	if (!Number.isFinite(config.sandboxRetentionHours) || config.sandboxRetentionHours <= 0) return refused("sandbox-retention-off", "workspace retention is off on this host; set PI_SANDBOX_RETENTION_HOURS to a positive number before preparing");
	const backend = resolveBackendName(trigger.run, config.defaultBackend);
	if (!["local", "podman"].includes(backend)) return refused("sandbox-venue-unsupported", "the selected trigger's venue has no sandbox shell; choose a local or podman trigger");
	if (!Array.isArray(config.backends) || !config.backends.includes(backend)) return refused("sandbox-venue-unblessed", "the selected host does not bless the trigger's venue in PI_BACKENDS");
	if (typeof config.egress !== "boolean" || typeof config.egressProxy !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.egressProxy)) return configRefusal();
	if (request.pin && (!Number.isInteger(config.sandboxPinDays) || config.sandboxPinDays < 1)) return configRefusal();
	let image, size;
	const project = projectOf({ kind, repo: request.repo }, projects);
	try {
		image = resolveJobImage(trigger.run, config.jobImage);
		if (!image) return configRefusal();
		size = resolveJobSize({ project, limits, env });
	} catch { return configRefusal(); }
	const plan = { host: request.host, repo: request.repo, ref: request.ref ?? "HEAD", triggerIndex: request.triggerIndex, triggerDigest: digest, kind, image, backend, size, egress: { armed: config.egress, proxy: config.egressProxy }, retentionHours: config.sandboxRetentionHours, pin: request.pin === true, pinDays: config.sandboxPinDays, project };
	const planDigest = hash(JSON.stringify(plan));
	if (request.planDigest !== undefined && request.planDigest !== planDigest) return refused("sandbox-plan-changed", "the host's image, size, venue, egress or retention changed; preview the sandbox again");
	return { plan: { ...plan, planDigest } };
}

/** The lazily created standalone CLI uses the same forge factories; a wired worker can supply its existing forgeFor. */
async function defaultForgeFor(kind, config, env) {
	if (!config[kind]) return null;
	if (kind === "github") {
		const { makeGitHubAuth } = await import("./get-token.mjs");
		return { auth: await makeGitHubAuth(config.github, { env }) };
	}
	if (kind === "gitlab") {
		const { makeGitLabAuth } = await import("./gitlab-auth.mjs");
		return { auth: await makeGitLabAuth(config.gitlab, { env }) };
	}
	if (kind === "forgejo") {
		const { makeForgejoAuth } = await import("./forgejo-auth.mjs");
		return { auth: await makeForgejoAuth(config.forgejo, { env }) };
	}
	if (kind === "azure") {
		const { makeAzureAuth } = await import("./azure-auth.mjs");
		return { auth: await makeAzureAuth(config.azure, { env }) };
	}
	return null;
}

export async function observeSandboxPreparation({ backend, image, config, inspectImage = null, decideUser = null, readStore = null }) {
	const { decideSandboxJobUser, readPodmanStore } = await import("./sandbox.mjs");
	// Identity can use the image's own uid on some platforms without inspecting it. Presence is an independent gate:
	// an absent image must be refused before minting or cloning, even on macOS, Windows, or the baked uid's account.
	const inspect = inspectImage ?? makeImagePreflight({ image, bin: backend === "podman" ? "podman" : "docker" });
	const inspected = await inspect({});
	if (inspected?.unavailable) throw new Error("the sandbox image runtime did not answer");
	if (inspected?.ok !== true) return refused("sandbox-image-unavailable", "the selected image is not available on this host; pull or build the trigger's image before preparing");
	const user = await (decideUser ?? decideSandboxJobUser)({ manifest: { image, backend }, venue: backend, backendFloor: config.backendFloor });
	// The interactive opener refuses unread observations because it has no queue. Preparation has a bounded retry,
	// so the CLI's "try again" results must regain their infrastructure meaning here, without matching prose.
	if (["job-user-unknown", "podman-conf-unread", "podman-unobserved"].includes(user?.refused)) throw new Error("the sandbox's user or isolation observations could not be read");
	if (user?.refused === "job-user-image") {
		const again = await inspect({});
		if (again?.missing) return refused("sandbox-image-unavailable", "the selected image disappeared from this host; pull or build it before preparing");
		throw new Error("the sandbox image's user capabilities could not be read");
	}
	if (user?.refused) return user;
	const podmanStore = backend === "podman" ? await (readStore ?? readPodmanStore)() : null;
	if (backend === "podman" && (typeof podmanStore !== "string" || !podmanStore)) throw new Error("the sandbox's rootless container store could not be read");
	return { jobUser: { user: user?.user ?? null, home: user?.home ?? null }, ...(podmanStore ? { podmanStore } : {}) };
}

/**
 * Each accepted request has one id and one final manifest. The exclusive per-id host lock protects direct CLI work
 * against a queue retry, and a reconciled ready manifest is returned before another credential or clone is requested.
 */
export function createSandboxPreparer({ env = process.env, config = loadConfig(env), readTriggers = () => nodeFs.readFileSync(config.triggersFile ?? join(process.cwd(), "triggers.json"), "utf8"), projects = () => loadProjects(config), limits = () => loadScopedLimits(config), forgeFor = null, clone = cloneHostWorkspace, resolveRef = resolveSandboxRef, observe = observeSandboxPreparation, now = Date.now, fs = nodeFs, ensureDir = ensureSandboxDir, ensureJobs = ensureJobsDir, pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } } } = {}) {
	return async function prepare(request) {
		let planned;
		try { planned = planSandboxPreparation({ request, config, env, triggersText: readTriggers(), projects: projects(), limits: limits() }); }
		catch (error) { if (error?.piDispatchConfig || error?.code === "ENOENT") return configRefusal(); throw new Error("sandbox preparation configuration read failed", { cause: error }); }
		if (planned.refused) return planned;
		const { plan } = planned;
		const id = request.id ?? newSandboxId();
		const fingerprint = hash(JSON.stringify({ plan, by: request.by ?? null }));
		let remote;
		try {
			remote = sandboxRemoteUrl(plan.kind, plan.repo, config);
			ensureDir(config.sandboxDir, { env });
			fs.mkdirSync(config.sandboxDir, { recursive: true, mode: 0o700 });
			ensureDir(config.sandboxDir, { env });
			ensureJobs(config.jobsDir, { env });
			if (fs.statSync(config.jobsDir).dev !== fs.statSync(config.sandboxDir).dev) return refused("sandbox-config-invalid", "PI_JOBS_DIR and PI_SANDBOX_DIR must be on the same filesystem for atomic preparation; adjust this host's deployment before retrying");
		} catch (error) { if (error?.piDispatchConfig) return configRefusal(); throw new Error("sandbox preparation directories could not be secured", { cause: error }); }
		// The retention sweep removes non-directory entries in its root. This live lock belongs beside staging,
		// outside that sweep, or a sweep during the awaited clone could let a second owner publish the same id.
		const lock = join(config.jobsDir, `${id}.lock`);
		let ownership;
		try { ownership = takePreparationLock(lock, { fs, pidAlive, jobsDir: config.jobsDir }); }
		catch (error) { throw new Error("sandbox preparation lock could not be acquired", { cause: error }); }
		if (!ownership) return refused("sandbox-preparation-busy", "this sandbox is already being prepared, or its lock could not be safely recovered; inspect this host before retrying");
		let staging = null;
		try {
			const dest = join(config.sandboxDir, id);
			let exists = false;
			try { fs.lstatSync(dest); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
			if (exists) {
				const manifest = readManifest({ sandboxDir: config.sandboxDir, jobId: id, fs });
				if (manifest?.jobId === id && manifest.prepared?.requestDigest === fingerprint) return ready(manifest, plan.host, config.sandboxRetentionHours);
				return refused("sandbox-id-collision", "the sandbox id already names another workspace; prepare again with a new id");
			}
			const observations = await observe({ backend: plan.backend, image: plan.image, config });
			if (observations?.refused) return observations;
			let pair;
			try { pair = await forgeFor?.({ kind: plan.kind, repo: plan.repo }); if (!pair?.auth) pair = await defaultForgeFor(plan.kind, config, env); }
			catch (error) { if (error?.piDispatchConfig) return refused("sandbox-credential-unavailable", "the host's forge credential is not configured; run pi-dispatch doctor on that host"); throw new Error("sandbox forge authentication temporarily failed", { cause: error }); }
			if (typeof pair?.auth?.mintToken !== "function") return refused("sandbox-credential-unavailable", "the host has no credential for the selected forge");
			// Narrow the installation token even when this host's ordinary jobs need write access.
			let token;
			try { token = await pair.auth.mintToken({ kind: plan.kind, repo: plan.repo, ...(plan.kind === "github" ? { permissions: { contents: "read" } } : {}) }); }
			catch (error) { if (error?.piDispatchConfig) return refused("sandbox-credential-unavailable", "the host's forge credential cannot read this repository"); throw new Error("sandbox clone credential temporarily unavailable", { cause: error }); }
			if (typeof token !== "string" || token.trim() === "") return refused("sandbox-credential-unavailable", "the host's forge credential is empty");
			// The lock names this directory BEFORE it exists, closing the mkdir-to-record crash window. A restart
			// reclaims exactly that dead owner's directory, including a clone too young for the boot orphan sweep.
			const stagePath = join(config.jobsDir, ownership.stageName);
			fs.mkdirSync(stagePath, { mode: 0o700 });
			staging = stagePath;
			const workspace = join(staging, "workspace");
			let cloned;
			try {
				const resolved = await resolveRef({ kind: plan.kind, repo: plan.repo, ref: plan.ref, config, token });
				if (resolved?.refused) return resolved;
				cloned = await clone({ workspace, remote, ref: resolved.fetchRef, token, env });
			} catch (error) {
				if (isCloneRefGone(error)) return refused("sandbox-ref-unavailable", "the repository no longer serves the requested ref; choose another ref");
				throw new Error("sandbox clone failed; check the host's forge connection", { cause: error });
			} finally { token = null; }
			if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(cloned?.sha ?? "")) throw new Error("sandbox clone returned no commit id");
			const at = now();
			const manifest = { jobId: id, kind: plan.kind, origin: "prepared", image: plan.image, backend: plan.backend, jobUser: observations?.jobUser ?? null, ...(observations?.podmanStore ? { podmanStore: observations.podmanStore } : {}), size: plan.size, sandboxEgress: plan.egress, workspace: join(dest, "workspace"), baseSha: cloned.sha, createdAt: new Date(at).toISOString(), retainUntil: new Date(at + plan.retentionHours * 3_600_000).toISOString(), keepUntil: plan.pin ? new Date(at + plan.pinDays * 86_400_000).toISOString() : null, prepared: { requestId: id, requestDigest: fingerprint, triggerIndex: plan.triggerIndex, triggerDigest: plan.triggerDigest, repo: plan.repo, ref: plan.ref } };
			fs.writeFileSync(join(staging, SANDBOX_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			// Nothing under the retention root is visible until the clone AND manifest are complete.
			try { fs.lstatSync(dest); return refused("sandbox-id-collision", "another workspace appeared under this id; nothing was replaced"); } catch (error) { if (error.code !== "ENOENT") throw error; }
			fs.renameSync(staging, dest);
			staging = null;
			return ready(manifest, plan.host, config.sandboxRetentionHours);
		} finally {
			try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
			finally { releasePreparationLock(lock, ownership, fs); }
		}
	};
}

/** Descriptor-backed lock identity, so a replaced path and an unreadable/FIFO lock are never judged stale. */
function readPreparationLock(path, fs) {
	let fd;
	try {
		const before = fs.lstatSync(path);
		if (!before.isFile() || before.size > PREPARATION_LOCK_MAX_BYTES) return null;
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > PREPARATION_LOCK_MAX_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) return null;
		const body = fs.readFileSync(fd, "utf8");
		return { body, dev: stat.dev, ino: stat.ino };
	} catch { return null; }
	finally { if (fd !== undefined) fs.closeSync(fd); }
}

function moveLockAside(path, why, fs) {
	const moved = `${path}.${why}.${randomBytes(16).toString("hex")}`;
	try { fs.renameSync(path, moved); return moved; } catch { return null; }
}
function sameLock(a, b) { return a && b && a.body === b.body && a.dev === b.dev && a.ino === b.ino; }
function restoreLock(moved, path, fs) {
	try { fs.linkSync(moved, path); } catch {}
	try { fs.unlinkSync(moved); } catch {}
}
function takePreparationLock(path, { fs, pidAlive, jobsDir }) {
	const stageName = `job-sb-${randomBytes(16).toString("hex")}`;
	const body = JSON.stringify({ pid: process.pid, tag: randomBytes(16).toString("hex"), jobsRoot: fs.realpathSync(jobsDir), stageName });
	for (let attempt = 0; attempt < 2; attempt++) {
		let fd;
		try {
			fd = fs.openSync(path, "wx", 0o600);
			fs.writeFileSync(fd, body);
			const stat = fs.fstatSync(fd);
			return { body, dev: stat.dev, ino: stat.ino, stageName };
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const seen = readPreparationLock(path, fs);
			let owner;
			try { owner = JSON.parse(seen?.body); } catch { return null; }
			if (!Number.isInteger(owner?.pid) || owner.pid < 1 || pidAlive(owner.pid)) return null;
			// Like the checkpoint store: move, verify the exact observed generation, and only then discard it.
			// An unlink of this path could remove a rival's new lock on evidence about the dead predecessor.
			const moved = moveLockAside(path, "stale", fs);
			if (!moved) continue;
			if (!sameLock(readPreparationLock(moved, fs), seen)) { restoreLock(moved, path, fs); return null; }
			try { reclaimPreparationStage(owner, jobsDir, fs); }
			catch (error) { restoreLock(moved, path, fs); throw error; }
			fs.unlinkSync(moved);
		} finally { if (fd !== undefined) fs.closeSync(fd); }
	}
	return null;
}
function reclaimPreparationStage(owner, jobsDir, fs) {
	if (owner.stageName === undefined) return;
	if (!/^job-sb-[a-f0-9]{32}$/.test(owner.stageName) || owner.jobsRoot !== fs.realpathSync(jobsDir)) throw new Error("the old preparation's staging root changed; inspect it before retrying");
	const stage = join(jobsDir, owner.stageName);
	let stat;
	try { stat = fs.lstatSync(stage); } catch (error) { if (error.code === "ENOENT") return; throw error; }
	if (!stat.isDirectory() || (Number.isInteger(process.geteuid?.()) && stat.uid !== process.geteuid())) throw new Error("the old preparation's staging directory changed ownership or type");
	fs.rmSync(stage, { recursive: true, force: true });
}
function releasePreparationLock(path, ownership, fs) {
	const moved = moveLockAside(path, "release", fs);
	if (!moved) return;
	if (sameLock(readPreparationLock(moved, fs), ownership)) fs.unlinkSync(moved);
	else restoreLock(moved, path, fs);
}

export const makeSandboxPreparer = createSandboxPreparer;

function ready(manifest, host, retentionHours) {
	const deadline = sandboxDeadline(manifest, retentionHours);
	return { id: manifest.jobId, host, until: deadline.until, pinned: deadline.source === "pin", backend: manifest.backend, prepared: true, generation: sandboxManifestGeneration(manifest) };
}

export function createSandboxPinHandler({ config, now = Date.now, fs = nodeFs, pin = pinSandbox } = {}) {
	return async (request) => {
		if (request?.host !== config.workerName || !/^[A-Za-z0-9._:-]{1,200}$/.test(request?.runId ?? "")) return refused("sandbox-pin-invalid", "choose a kept workspace on this host");
		const manifest = readManifest({ sandboxDir: config.sandboxDir, jobId: request.runId, fs });
		if (!manifest || manifest.jobId !== request.runId) return refused("sandbox-absent", "the kept workspace is gone; refresh the Sandboxes tab");
		const deadline = sandboxDeadline(manifest, config.sandboxRetentionHours);
		if (request.expect && (request.expect.until !== deadline.until || request.expect.pin !== (deadline.source === "pin") || request.expect.generation !== sandboxManifestGeneration(manifest))) return refused("sandbox-changed", "the kept workspace changed after the preview; refresh and preview it again");
		const result = pin({ sandboxDir: config.sandboxDir, jobId: request.runId, pinDays: config.sandboxPinDays, fs, now });
		if (!result.pinned) return refused("sandbox-pin-failed", "the workspace could not be pinned on its host; refresh and check the host's retention directory");
		return { id: request.runId, host: config.workerName, until: Date.parse(result.keepUntil), pinned: true, generation: sandboxManifestGeneration(manifest) };
	};
}
