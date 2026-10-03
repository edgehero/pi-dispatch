/**
 * `pi-dispatch init` — scaffold a deployment's config files in the current folder.
 *
 * Idempotent and non-destructive: an existing file is reported and left as-is, so re-running init
 * never overwrites operator edits. The scaffolds mirror the empty templates the worker validates
 * against — an empty triggers list disables cron/label/comment/PR, an empty windows list means no
 * scoped pauses, an empty packages list stages nothing, an empty subscriptions list declares no plan
 * prices — so a fresh deployment starts inert and is opted into feature by feature.
 */
import { existsSync, copyFileSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseBackendList, venuesOf } from "./backends.mjs";
import { deploymentVenueEnv } from "./deployment-venue.mjs";
import { setEnvKeyIfEmpty } from "./env-file.mjs";
import { PACKAGED_EGRESS_PROXY_CONF } from "./egress-conf-copy.mjs";
import { EMPTY_MODEL_ENDPOINTS, MODEL_ENDPOINTS_FILE_NAME, MODEL_ENDPOINTS_INCLUDE_NAME, renderEndpointsInclude } from "./model-endpoints.mjs";
import { VALKEY_PASSWORD_KEY, newValkeyPassword } from "./valkey-auth.mjs";

const EMPTY_TRIGGERS = `${JSON.stringify({ triggers: [] }, null, 2)}\n`;
/**
 * EXPORTED so a test scaffolds what `init` scaffolds (issue #384). Doctor now asks the worker's own loader
 * whether a configured file loads, and the fixtures wrote `[]` and `{}`, which those loaders refuse: a test
 * that scaffolds content the product never writes measures the wrong deployment.
 */
export const EMPTY_PAUSE_WINDOWS = `${JSON.stringify({ windows: [] }, null, 2)}\n`;
// Pinned third-party pi packages staged into the global overlay (issue #58). Empty by default: staging
// runs third-party code inside jobs, so it is opted into package by package, never scaffolded populated.
const EMPTY_PACKAGES = `${JSON.stringify({ packages: [] }, null, 2)}\n`;
// Operator-declared subscription plans (issue #53), read by the admin extension only — never at job
// time. Versioned because a newer file must fail loud, and that cannot be retrofitted into a v1 reader.
const EMPTY_SUBSCRIPTIONS = `${JSON.stringify({ version: 1, subscriptions: [] }, null, 2)}\n`;
// Scoped limits (issue #242): per repo/folder run caps and concurrency. Empty is inert -- and the
// one-job-per-folder mutex for local jobs is code, not configuration, so it needs no scaffold line.
// Versioned for the subscriptions reason, sharpened: this is enforcement config, and a silently
// down-read newer file would be a silently widened spend limit.
export const EMPTY_SCOPED_LIMITS = `${JSON.stringify({ version: 1, limits: [] }, null, 2)}\n`;
// Projects (issue #499): named groups of repos and folders, recorded per run. Empty is inert: every run records no
// project. Versioned for the scoped-limits reason, since part B of the issue caps a project as one.
export const EMPTY_PROJECTS = `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`;
/**
 * The egress allowlist (REQ-EGRESS-ALLOWLIST): the hosts a job container may reach, one bare hostname per
 * line. Scaffolded with the three a job cannot work without, and NOT empty -- unlike every other scaffold
 * in this file, whose empty form is inert. An empty allowlist is not inert, it is a deployment where every
 * job dies at its first turn, so the safe default here is the working minimum rather than nothing.
 *
 * The provider is an ordinary entry. No address-based rule allows it (the proxy's one address rule only denies this
 * host's loopback and link-local addresses, issue #428), and nothing is special about it: the
 * proxy carries provider traffic like everything else, because the runner's own `fetch` follows the proxy
 * once NODE_USE_ENV_PROXY is set, which the worker sets (worker/src/egress.mjs).
 */
const DEFAULT_EGRESS_ALLOWLIST = `# Hosts a job container may reach, one per line. Deny by default: anything not listed is refused by
# the proxy, and a job container has no other route out. A leading dot matches subdomains.
#
# Not read when PI_EGRESS=0. Edit freely -- \`pi-dispatch init\` never overwrites this file, and
# \`pi-dispatch doctor\` reports what the running policy actually permits. See docs/egress.md.
#
# Your flows are the part nobody can list for you: a job that browses, or installs, or calls an API you
# added, reaches hosts that are not here. doctor names what it can; the rest you have to know.

# The provider. Every turn of every job goes here.
api.anthropic.com

# Your forge, for the push and the pull request. Replace with your own host if you self-host, and drop
# the ones you do not use.
.github.com

# Only needed when a job installs the serviced repo's own dependencies.
registry.npmjs.org
`;

// The package's own copy of the proxy's rules, which init scaffolds (issue #480). It lives in egress-conf-copy.mjs since
// issue #484, beside the comparison doctor and `up` make against it, and is re-exported here for init's callers.
export { PACKAGED_EGRESS_PROXY_CONF };

/**
 * `deps.env` is the caller's environment (the CLI's and doctor's pass theirs), and `deps.venues` a venue set the caller
 * already decided (`up` passes its own, so the two never disagree). Otherwise the venue is decided as `up` decides it
 * (`deploymentVenueEnv`): this shell where it sets a key, else the deployment `.env`, and a disagreement between the two
 * is said instead of any next steps. The default `env` is `{}` and not `process.env` so a test is never steered by the
 * shell it runs in. `deps.steps: false` prints the file list and no "Next:" at all: `up` passes it (issue #480), since
 * `up` performs that ladder itself and printing it mid-pass told a reader to do by hand what was being done for them.
 */
export function runInit(cwd = process.cwd(), deps = {}) {
	const { fs = { existsSync, copyFileSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync }, readPackageFile = readFileSync, out = (s) => process.stdout.write(s), env = {}, platform = process.platform, newPassword = newValkeyPassword } = deps;
	const results = [];
	// The list prints even when a write throws part way (PR #488's final review: a read-only deploy/ lost the seven lines
	// of what init had already created, leaving one EACCES line), so the operator always sees what now exists.
	const printList = () => {
		// The name column is as wide as the longest name (issue #480): a fixed 20 put egress-allowlist.conf's note out of line.
		const width = Math.max(...results.map(([, name]) => name.length));
		for (const [verb, name, note] of results) {
			out(`${verb.padEnd(7)} ${name.padEnd(width)} ${note}\n`);
		}
	};
	const envPath = join(cwd, ".env");
	try {
		// .env from the example. Prefer the copy in cwd (the clone's repo root); fall back to the copy
		// SHIPPED with the worker package (worker/.env.example, kept byte-identical to the root example by
		// worker/test/publish.test.mjs) so init works both from elsewhere in a checkout and from an npm
		// install, where the repo root does not exist.
		if (fs.existsSync(envPath)) {
			results.push(["kept", ".env", KEPT]);
		} else {
			const cwdExample = join(cwd, ".env.example");
			const source = fs.existsSync(cwdExample)
				? cwdExample
				: fileURLToPath(new URL("../.env.example", import.meta.url));
			// Issue #468: the new file carries this deployment's own Valkey password (the example's `# VALKEY_PASSWORD=` line
			// filled in, never shown) and is created readable by this account alone: it holds that password and, soon, the
			// provider key. `wx`: a file that appeared since the check above is never overwritten (init's contract).
			// Its GROUP is the folder's choice and left so (issue #522): on macOS a new file takes the folder's group (`wheel`
			// under `/private/tmp`), and on Linux a setgid folder's, which is how a shared deployment gives the service its
			// group. Setting this account's group here was considered and rejected: it would undo that shared layout, and the
			// writer `up` uses keeps whatever group a new file there gets, so the fresh file is never refused for it.
			const text = setEnvKeyIfEmpty(String(fs.readFileSync(source, "utf8")), VALKEY_PASSWORD_KEY, newPassword(), { platform });
			if (createOnly(fs, envPath, text, { mode: 0o600 })) results.push(["created", ".env", `from .env.example, mode 0600, with a generated ${VALKEY_PASSWORD_KEY} (value not shown): set your provider key next`]);
			else results.push(["kept", ".env", KEPT]);
		}

		scaffold(fs, results, join(cwd, "triggers.json"), EMPTY_TRIGGERS, "empty triggers list");
		scaffold(fs, results, join(cwd, "pause-windows.json"), EMPTY_PAUSE_WINDOWS, "empty pause-windows list");
		scaffold(fs, results, join(cwd, "pi-packages.json"), EMPTY_PACKAGES, "empty pi package list (stage with import-pi --with-packages)");
		scaffold(fs, results, join(cwd, "subscriptions.json"), EMPTY_SUBSCRIPTIONS, "empty subscription list (declare plan prices for the admin's cost analytics)");
		scaffold(fs, results, join(cwd, "scoped-limits.json"), EMPTY_SCOPED_LIMITS, "empty scoped-limits list (per repo/folder caps; the folder mutex needs no file)");
		scaffold(fs, results, join(cwd, "projects.json"), EMPTY_PROJECTS, "empty projects list (group repos and folders into a project, recorded per run)");
		scaffold(fs, results, join(cwd, "egress-allowlist.conf"), DEFAULT_EGRESS_ALLOWLIST, "egress allowlist (provider + forge + registry; the egress policy is on unless PI_EGRESS=0)");
		// Issue #503: the declared model endpoints, empty, and the proxy include rendered from them, which is the empty
		// render (its header only). squid refuses to start on a missing include file and starts on a comments-only one
		// (measured), so the include exists from the first init even with nothing declared.
		scaffold(fs, results, join(cwd, MODEL_ENDPOINTS_FILE_NAME), EMPTY_MODEL_ENDPOINTS, "empty model endpoints list (local or LAN model servers a job may reach through the proxy)");
		scaffold(fs, results, join(cwd, MODEL_ENDPOINTS_INCLUDE_NAME), renderEndpointsInclude([]), "the proxy's rules for those endpoints, none yet (generated: do not edit)");
		// Issue #480: the proxy's rules, the file beside the allowlist that the docker proxy mounts. Create-only like every
		// scaffold here, so a clone's own deploy/egress-proxy.conf is reported and kept. The one scaffold whose content is
		// not this module's: it is the package's file verbatim, read from the package and never through `fs` (the
		// deployment folder's seam), as `up` reads its Quadlet templates. The podman venue does not read this copy (its unit
		// mounts an account-owned copy `service install` writes), and it costs nothing there.
		//
		// Only into a deploy/ that is a real directory of this folder (PR #488's review): a symlinked deploy/ would put the
		// file wherever the link points, so init refuses there and writes nothing, and says so. Asked again after the mkdir,
		// so a link that appeared in between is refused too.
		const deployDir = join(cwd, "deploy");
		const notOurDir = () => {
			const st = lstatOrNull(fs, deployDir);
			return st && (st.isSymbolicLink() || !st.isDirectory()) ? (st.isSymbolicLink() ? "a symlink" : "not a directory") : null;
		};
		let deployRefusal = notOurDir();
		if (!deployRefusal && !lstatOrNull(fs, deployDir)) {
			fs.mkdirSync(deployDir, { recursive: true });
			deployRefusal = notOurDir();
		}
		if (deployRefusal) {
			results.push(["refused", "deploy/egress-proxy.conf", `deploy/ here is ${deployRefusal}, so init writes nothing into it: make deploy/ a directory of this folder, then run \`pi-dispatch init\` again`]);
		} else {
			scaffold(fs, results, join(deployDir, "egress-proxy.conf"), () => readPackageFile(PACKAGED_EGRESS_PROXY_CONF), "the egress proxy's rules, the package's copy (shipped, not edited; the hosts go in the allowlist)", "deploy/egress-proxy.conf");
		}
	} catch (err) {
		printList();
		throw err;
	}
	printList();
	// A refused scaffold is a failed init (fail loudly): the line above says which, and the steps below still print.
	const code = results.some(([verb]) => verb === "refused") ? 1 : 0;
	if (deps.steps === false) return code;
	if (deps.venues) {
		out(nextSteps(deps.venues, { platform }));
		return code;
	}
	// Decided exactly as `up` decides it (issue #453, gate round 1): a next-steps ladder for a venue `up` would refuse to
	// guess is a ladder for the wrong venue. The files above are scaffolded either way; only the steps wait.
	const venue = deploymentVenueEnv({ env, fs, envPath, platform, command: "init" });
	if (venue.error) {
		out(`\nNext: which venue this deployment runs is unknown, so no steps are shown: ${venue.error}. Then run \`pi-dispatch init\` again for them (it keeps every file above).\n`);
		return code;
	}
	for (const note of venue.notes) out(`⚠ ${note}\n`);
	try {
		parseBackendList(venue.env.PI_BACKENDS);
	} catch (err) {
		out(`\nNext: which venue this deployment runs is unknown, so no steps are shown: ${err.message}. Fix PI_BACKENDS, then run \`pi-dispatch init\` again for them (it keeps every file above).\n`);
		return code;
	}
	out(nextSteps(venuesOf(venue.env), { platform }));
	return code;
}

const KEPT = "already exists, left untouched";

// `name` is what the list shows, the file's own name unless it sits below the folder; `content` may be a function, so a
// file read from the package is read only when it is about to be written.
function scaffold(fs, results, path, content, note, name = path.split(/[\\/]/).pop()) {
	// A DIRECTORY where the file belongs (PR #488's review) is not "kept": every reader of these files wants a file, and
	// docker mounts a directory at deploy/egress-proxy.conf where squid reads its config. Followed through a link, too.
	if (isDirectory(fs, path)) {
		results.push(["refused", name, `${name} here is a directory, not a file: remove it, then run \`pi-dispatch init\` again`]);
	} else if (fs.existsSync(path)) {
		results.push(["kept", name, KEPT]);
	} else if (createOnly(fs, path, typeof content === "function" ? content() : content)) {
		results.push(["created", name, note]);
	} else {
		results.push(["kept", name, KEPT]);
	}
}

/**
 * Every scaffold's write (PR #488's review): `wx` (O_CREAT|O_EXCL), so nothing that exists is written through, not even
 * a dangling symlink, which `existsSync` reports absent and a plain write follows out of the folder. EEXIST is "kept",
 * as init's contract says; any other failure is thrown as it was.
 */
function createOnly(fs, path, content, opts = {}) {
	try {
		fs.writeFileSync(path, content, { ...opts, flag: "wx" });
		return true;
	} catch (err) {
		if (err?.code === "EEXIST") return false;
		throw err;
	}
}

function isDirectory(fs, path) {
	const st = lstatOrNull(fs, path);
	if (!st) return false;
	if (!st.isSymbolicLink()) return st.isDirectory();
	try {
		return typeof fs.statSync === "function" && fs.statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function lstatOrNull(fs, path) {
	try {
		return fs.lstatSync(path);
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
}

/**
 * The docker text is the same for every set that includes `local`. Its step 2 was a compose command naming
 * deploy/docker-compose.yml, a file a folder made by init alone does not have (issue #480), and it started no egress
 * proxy either; it is now `pi-dispatch up`, which starts Valkey and the proxy itself. A podman-only deployment (issue
 * #453) gets the podman ladder instead, the steps of docs/podman.md "Setup" in the order a fresh folder needs them
 * (named by its URL since #480, because a folder made without a clone has no docs/):
 * the job image into this account's own store, the venue key and provider key in `.env` (what `up` and `service
 * install` read), the stack as Quadlet units, doctor, and the worker as a user service.
 */
export function nextSteps(venues = { localUsed: true, podmanUsed: false }, { platform = "linux" } = {}) {
	if (venues.podmanUsed && !venues.localUsed) return platform === "linux" ? PODMAN_NEXT_STEPS : PODMAN_OFF_LINUX;
	return `
Next:
  1. docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest
                                                        # the prebuilt job image (or build your own from a clone)
  2. pi-dispatch up                                     # Valkey and the egress proxy (unless PI_EGRESS=0)
  3. edit .env                                          # set ANTHROPIC_API_KEY (or your provider's key)
  4. pi-dispatch doctor                                 # verify Docker, Valkey, image, and key
  5. pi-dispatch worker                                 # drain the queue

Operator panel (optional): pi install npm:@edgehero/pi-dispatch-admin   then   /dispatch
  (or let the panel do all of the above: /dispatch setup walks these steps with a consent per action)
`;
}

// Off Linux the podman venue refuses the host (`podman-platform`: Podman machine on macOS and Windows was never
// measured), so its ladder would walk an operator into Quadlet steps that cannot work here.
const PODMAN_OFF_LINUX = `
Next: PI_BACKENDS lists only the podman venue, which runs on Linux alone: on this host the worker refuses it
(podman-platform), so there are no podman steps to run here. Run this deployment on a Linux host, or add \`local\` to
PI_BACKENDS to run jobs on Docker here (then run \`pi-dispatch init\` again for those steps).
`;

const PODMAN_NEXT_STEPS = `
Next (the podman venue; run these as the worker's own account. First set the account up as the Podman guide's "Setup"
steps 1-4 say (https://github.com/edgehero/pi-dispatch/blob/main/docs/podman.md), linger included:
sudo loginctl enable-linger <account>, without which a job gets no bounds):
  1. podman pull ghcr.io/edgehero/pi-job:latest && podman tag ghcr.io/edgehero/pi-job:latest pi-job:latest
                                                        # the prebuilt job image, in this account's own store
  2. edit .env                                          # PI_BACKENDS=podman, and ANTHROPIC_API_KEY (or your provider's key)
  3. pi-dispatch up                                     # Valkey and the egress proxy as Quadlet units in your user manager
  4. pi-dispatch doctor                                 # verify Podman, Valkey, image, and key
  5. pi-dispatch service install                        # the worker as a user service, after those units (also installs them)
  6. pi-dispatch doctor --live                          # read the bounds, egress and job user back off real containers

Operator panel (optional): pi install npm:@edgehero/pi-dispatch-admin   then   /dispatch
  (or let the panel do all of the above: /dispatch setup walks these steps with a consent per action)
`;
