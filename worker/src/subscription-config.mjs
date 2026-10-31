import * as fs from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createAuthService, parseAuthConnections } from "./auth-connections.mjs";
import { makeSubscriptionQuotaStore } from "./subscription-quota.mjs";
import { makeSubscriptionRuntime } from "./subscription-runtime.mjs";
import { readOverlayModels } from "./model-endpoints.mjs";
import { failoverModelView } from "./model-status.mjs";
import { CONTAINER_GLOBAL_PI_DIR } from "./container-spec.mjs";
import { readStageManifest, containerPackagePaths } from "./packages.mjs";
import { authError } from "./auth-store.mjs";
import { COMMUNITY_AUTH_ADAPTERS } from "./community-auth-adapters.mjs";
import { insideDirectory, privateStoreExposed } from "./private-store-boundary.mjs";

const inside = insideDirectory;
export function readAuthPolicy(path, { uid = process.getuid?.() } = {}) {
	let fd;
	try {
		fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o022) !== 0 || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) throw Object.assign(new Error("the subscription connection policy must be a private, owned regular file"), { code: "auth-policy-invalid" });
		return parseAuthConnections(fs.readFileSync(fd, "utf8"));
	} catch (error) {
		if (error.code?.startsWith("auth-")) throw error;
		const transient = ["EIO", "EAGAIN", "EMFILE", "ENFILE"].includes(error.code);
		throw authError(transient ? "auth-policy-unavailable" : "auth-policy-invalid", { transient });
	} finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function configuredSubscriptions({ config, redis, now = Date.now, adapters, fetch } = {}) {
	if (!config.authConnectionsFile) return null;
	const storeDir = config.authStoreDir ?? resolve(dirname(config.settingsFile), "subscription-auth");
	for (const root of [config.globalPiDir, config.jobsDir, config.sandboxDir]) if (root && privateStoreExposed(root, storeDir)) throw Object.assign(new Error("the private subscription store must be outside every job or overlay root"), { code: "auth-store-location" });
	const readPolicy = () => readAuthPolicy(config.authConnectionsFile);
	readPolicy();
	const auth = createAuthService({ readPolicy, storeDir, host: config.workerName, now, ...(adapters ? { adapters } : {}), ...(fetch ? { fetch } : {}) });
	if (!redis) return { auth, quota: null, runtime: null, storeDir };
	const quota = makeSubscriptionQuotaStore({ redis, now });
	const runtime = makeSubscriptionRuntime({ auth, quota, now, defaultBackend: config.defaultBackend, isPrivateStoreExposed: (job) => job.kind === "local" && privateStoreExposed(job.folder, storeDir), lookup: (provider, id) => failoverModelView(`${provider}/${id}`, { models: readOverlayModels(config.globalPiDir) }), packageRootFor: (adapter) => {
		const row = readPolicy().connections.find((entry) => entry.adapter === adapter && entry.ownerHost === config.workerName);
		if (!row?.root || !config.globalPiDir || !inside(resolve(config.globalPiDir, "packages"), row.root)) return null;
		const root = `${CONTAINER_GLOBAL_PI_DIR}/${relative(config.globalPiDir, row.root).split("\\").join("/")}`;
		const manifest = readStageManifest({ globalPiDir: config.globalPiDir });
		if (!manifest || !containerPackagePaths(manifest).includes(root)) return null;
		if (stagedAuthConflict(manifest, adapter)) return { refused: "auth-adapter-conflicting" };
		return { root, digest: row.digest };
	} });
	return { auth, quota, runtime, storeDir };
}

/** Both reviewed Claude packages replace the same provider; this conflict is knowable without executing either. */
export function stagedAuthConflict(manifest, adapter) {
	const selected = COMMUNITY_AUTH_ADAPTERS[adapter];
	return selected?.community === true && (manifest?.packages ?? []).filter((row) => COMMUNITY_AUTH_ADAPTERS[`${row.name}@${row.version}`]?.provider === selected.provider).length > 1;
}
