/**
 * `pi-dispatch init` — scaffold a deployment's config files in the current folder.
 *
 * Idempotent and non-destructive: an existing file is reported and left as-is, so re-running init
 * never overwrites operator edits. The scaffolds mirror the empty templates the worker validates
 * against — an empty triggers list disables cron/label/comment/PR, an empty windows list means no
 * scoped pauses, an empty packages list stages nothing, an empty subscriptions list declares no plan
 * prices — so a fresh deployment starts inert and is opted into feature by feature.
 */
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const EMPTY_TRIGGERS = `${JSON.stringify({ triggers: [] }, null, 2)}\n`;
const EMPTY_PAUSE_WINDOWS = `${JSON.stringify({ windows: [] }, null, 2)}\n`;
// Pinned third-party pi packages staged into the global overlay (issue #58). Empty by default: staging
// runs third-party code inside jobs, so it is opted into package by package, never scaffolded populated.
const EMPTY_PACKAGES = `${JSON.stringify({ packages: [] }, null, 2)}\n`;
// Operator-declared subscription plans (issue #53), read by the admin extension only — never at job
// time. Versioned because a newer file must fail loud, and that cannot be retrofitted into a v1 reader.
const EMPTY_SUBSCRIPTIONS = `${JSON.stringify({ version: 1, subscriptions: [] }, null, 2)}\n`;
/**
 * The egress allowlist (REQ-EGRESS-ALLOWLIST): the hosts a job container may reach, one bare hostname per
 * line. Scaffolded with the three a job cannot work without, and NOT empty -- unlike every other scaffold
 * in this file, whose empty form is inert. An empty allowlist is not inert, it is a deployment where every
 * job dies at its first turn, so the safe default here is the working minimum rather than nothing.
 *
 * The provider is an ordinary entry. There is no address-based rule and nothing is special about it: the
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

export function runInit(cwd = process.cwd(), deps = {}) {
	const { fs = { existsSync, copyFileSync, writeFileSync }, out = (s) => process.stdout.write(s) } = deps;
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
	scaffold(fs, results, join(cwd, "egress-allowlist.conf"), DEFAULT_EGRESS_ALLOWLIST, "egress allowlist (provider + forge + registry; the egress policy is on unless PI_EGRESS=0)");

	for (const [verb, name, note] of results) {
		out(`${verb.padEnd(7)} ${name.padEnd(20)} ${note}\n`);
	}
	out(nextSteps());
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

function nextSteps() {
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
