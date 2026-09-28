/**
 * `pi-dispatch init` — scaffold a deployment's config files in the current folder.
 *
 * Idempotent and non-destructive: an existing file is reported and left as-is, so re-running init
 * never overwrites operator edits. The scaffolds mirror the empty templates the worker validates
 * against — an empty triggers list disables cron/label/comment/PR, an empty windows list means no
 * scoped pauses, an empty packages list stages nothing, an empty subscriptions list declares no plan
 * prices — so a fresh deployment starts inert and is opted into feature by feature.
 */
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseBackendList, venuesOf } from "./backends.mjs";
import { deploymentVenueEnv } from "./deployment-venue.mjs";

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

/**
 * `deps.env` is the caller's environment (the CLI's and doctor's pass theirs), and `deps.venues` a venue set the caller
 * already decided (`up` passes its own, so the two never disagree). Otherwise the venue is decided as `up` decides it
 * (`deploymentVenueEnv`): this shell where it sets a key, else the deployment `.env`, and a disagreement between the two
 * is said instead of any next steps. The default `env` is `{}` and not `process.env` so a test is never steered by the
 * shell it runs in.
 */
export function runInit(cwd = process.cwd(), deps = {}) {
	const { fs = { existsSync, copyFileSync, readFileSync, writeFileSync }, out = (s) => process.stdout.write(s), env = {}, platform = process.platform } = deps;
	const results = [];

	// .env from the example. Prefer the copy in cwd (the clone's repo root); fall back to the copy
	// SHIPPED with the worker package (worker/.env.example, kept byte-identical to the root example by
	// worker/test/publish.test.mjs) so init works both from elsewhere in a checkout and from an npm
	// install, where the repo root does not exist.
	const envPath = join(cwd, ".env");
	if (fs.existsSync(envPath)) {
		results.push(["kept", ".env", "already exists — left untouched"]);
	} else {
		const cwdExample = join(cwd, ".env.example");
		const source = fs.existsSync(cwdExample)
			? cwdExample
			: fileURLToPath(new URL("../.env.example", import.meta.url));
		fs.copyFileSync(source, envPath);
		results.push(["created", ".env", "from .env.example — set your provider key next"]);
	}

	scaffold(fs, results, join(cwd, "triggers.json"), EMPTY_TRIGGERS, "empty triggers list");
	scaffold(fs, results, join(cwd, "pause-windows.json"), EMPTY_PAUSE_WINDOWS, "empty pause-windows list");
	scaffold(fs, results, join(cwd, "pi-packages.json"), EMPTY_PACKAGES, "empty pi package list (stage with import-pi --with-packages)");
	scaffold(fs, results, join(cwd, "subscriptions.json"), EMPTY_SUBSCRIPTIONS, "empty subscription list (declare plan prices for the admin's cost analytics)");
	scaffold(fs, results, join(cwd, "scoped-limits.json"), EMPTY_SCOPED_LIMITS, "empty scoped-limits list (per repo/folder caps; the folder mutex needs no file)");
	scaffold(fs, results, join(cwd, "egress-allowlist.conf"), DEFAULT_EGRESS_ALLOWLIST, "egress allowlist (provider + forge + registry; the egress policy is on unless PI_EGRESS=0)");

	for (const [verb, name, note] of results) {
		out(`${verb.padEnd(7)} ${name.padEnd(20)} ${note}\n`);
	}
	if (deps.venues) {
		out(nextSteps(deps.venues, { platform }));
		return 0;
	}
	// Decided exactly as `up` decides it (issue #453, gate round 1): a next-steps ladder for a venue `up` would refuse to
	// guess is a ladder for the wrong venue. The files above are scaffolded either way; only the steps wait.
	const venue = deploymentVenueEnv({ env, fs, envPath, platform, command: "init" });
	if (venue.error) {
		out(`\nNext: which venue this deployment runs is unknown, so no steps are shown: ${venue.error}. Then run \`pi-dispatch init\` again for them (it keeps every file above).\n`);
		return 0;
	}
	for (const note of venue.notes) out(`⚠ ${note}\n`);
	try {
		parseBackendList(venue.env.PI_BACKENDS);
	} catch (err) {
		out(`\nNext: which venue this deployment runs is unknown, so no steps are shown: ${err.message}. Fix PI_BACKENDS, then run \`pi-dispatch init\` again for them (it keeps every file above).\n`);
		return 0;
	}
	out(nextSteps(venuesOf(venue.env), { platform }));
	return 0;
}

function scaffold(fs, results, path, content, note) {
	const name = path.split(/[\\/]/).pop();
	if (fs.existsSync(path)) {
		results.push(["kept", name, "already exists — left untouched"]);
	} else {
		fs.writeFileSync(path, content);
		results.push(["created", name, note]);
	}
}

/**
 * The docker text is unchanged byte for byte for every set that includes `local`. A podman-only deployment (issue
 * #453) gets the podman ladder instead, the steps of docs/podman.md "Setup" in the order a fresh folder needs them:
 * the job image into this account's own store, the venue key and provider key in `.env` (what `up` and `service
 * install` read), the stack as Quadlet units, doctor, and the worker as a user service.
 */
export function nextSteps(venues = { localUsed: true, podmanUsed: false }, { platform = "linux" } = {}) {
	if (venues.podmanUsed && !venues.localUsed) return platform === "linux" ? PODMAN_NEXT_STEPS : PODMAN_OFF_LINUX;
	return `
Next:
  1. docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest
                                                        # the prebuilt job image (or build image/Dockerfile)
  2. docker compose -f deploy/docker-compose.yml up -d  # the durable queue (Valkey)
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
Next (the podman venue; run these as the worker's own account. First set the account up as docs/podman.md "Setup"
steps 1-4 say, linger included: sudo loginctl enable-linger <account>, without which a job gets no bounds):
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
