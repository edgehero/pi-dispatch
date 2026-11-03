/**
 * State this build still meets in the shape, or at the place, an older release left it (issue #761): one finding each,
 * which doctor prints as `state.older` and `up`'s summary repeats for the Valkey container.
 *
 * THE RULE for every later release: one that moves or reshapes a store and keeps the old shape readable registers a
 * detector here, gated so that it retires itself (it fires only while the old shape is really there, and says nothing
 * once it is gone), and adds a row to docs/upgrading.md. A detector fires on an EXACT older reference, never on
 * something an operator chose (an image they picked, a file they edited, a path they set): a warning that cannot go
 * away, or that argues with a deliberate choice, is one nobody reads.
 *
 * No data store has an older shape yet. Every versioned file and record this build reads, it also still writes:
 * versions are stamped by need (DES-STORE-VERSION-WHEN-NEEDED), so a version 1 file or record is what this build writes
 * too while nothing in it needs more, and job data's version 2 and the scoped limits' 3 are stamped only where a field
 * needs them. The older LOCATIONS of issues #290 and #464 (the run history and the settings overlay under the OS temp
 * dir, retained workspaces under the old shared jobs root) keep their own lines in doctor's `state` and `dirs` sections.
 *
 * What is here: the Valkey image older releases shipped, the floating `valkey/valkey:8`, which this release pins as
 * `VALKEY_IMAGE` (valkey-auth.mjs says why). An upgrade rewrites none of the three places that keep it:
 *   - a compose file in the deployment folder, which /dispatch setup copies create-only into `deploy/` (an earlier setup
 *     copied it to the folder's top);
 *   - the installed Quadlet unit, which only `service install --force` rewrites (`up` leaves a changed one as it is);
 *   - the `pi-dispatch-valkey` container an older `up` started, which keeps its image until it is recreated.
 *
 * Pure but for two seams, and it never throws: `readFile(path)` gives a file's text (a throw, a missing file, is no
 * finding), and `valkeyContainer()` gives `valkeyContainerOwner`'s verdict on the `pi-dispatch-valkey` container
 * (valkey-auth.mjs; null, a throw or no seam is no finding), which `upValkeyContainerImage` judges with the folder's
 * `handedOver`, and which also decides whether the compose file's fix recreates compose's valkey. A detector that cannot
 * read must not say something false.
 */
import { join } from "node:path";
import { COMPOSE_FILE, COMPOSE_VALKEY_OVERRIDE, VALKEY_IMAGE, VALKEY_VOLUME, composeArgs, composeProjectName } from "./valkey-auth.mjs";
import { QUADLET_FILES, quadletDir } from "./podman-stack.mjs";

/**
 * Every Valkey image reference an older release shipped, as each place spelled it: compose and `up`'s `docker run` the
 * short name, the Quadlet unit the fully qualified one. Matched EXACTLY, so `valkey/valkey:8.1`, `:8-alpine` and
 * `:8@sha256:...` (each an operator's or this release's choice) never are. When `VALKEY_IMAGE` moves on, the value it
 * leaves is added here, in both spellings; a test holds `VALKEY_IMAGE` out of this list.
 */
export const OLDER_VALKEY_IMAGES = Object.freeze(["valkey/valkey:8", "docker.io/valkey/valkey:8"]);

/** The container `up` starts Valkey as (`valkeyDockerRunArgs`), the one `valkeyContainer` gives the verdict on. */
export const VALKEY_CONTAINER = "pi-dispatch-valkey";

/**
 * The image of the Valkey container `owner` describes (`valkeyContainerOwner`'s verdict, valkey-auth.mjs), when `up`
 * runs that container itself, else null. THE one rule `up`'s summary and doctor's `state.older` both judge the container
 * by, so neither names a container the other leaves alone:
 *   - it is provably this deployment's (`ours`: up's label naming this folder, compose's working dir here, or,
 *     unlabelled, this deployment's VALKEY_URL port on 127.0.0.1). Another deployment's container, or one nothing ties
 *     to this folder, is never stopped or removed from here, and the fix below does both;
 *   - and the folder is not handed to compose (`handedOver` false: no `COMPOSE_VALKEY_OVERRIDE`). There compose runs the
 *     Valkey and recreates it from the compose file, which its own detector judges, and `pi-dispatch up` starts compose's
 *     valkey, never a container of its own.
 * Anything else, an unknown or absent verdict and a hand-over fact that is not a boolean included, is null: a fix that
 * could act on the wrong container is worse than no finding.
 */
export function upValkeyContainerImage(owner, { handedOver } = {}) {
	if (!upRunsValkey(owner, { handedOver })) return null;
	return typeof owner.image === "string" ? owner.image : null;
}

/**
 * Whether this deployment's `up` runs its Valkey as that container, whatever its image: the first half of
 * `upValkeyContainerImage`'s rule. Then compose does not run this deployment's Valkey, so the compose file's fix must
 * not recreate compose's valkey, which would start a second, empty one beside the queue.
 */
function upRunsValkey(owner, { handedOver } = {}) {
	return owner?.ours === true && handedOver === false;
}

/** The legacy place an earlier /dispatch setup copied the compose file to, relative to the deployment folder. */
export const LEGACY_COMPOSE_FILE = "docker-compose.yml";

// Said by every fix below, as `podman-stack.mjs` says it for a Valkey restart: the cost, and how to avoid it.
const INTERRUPTS = "A job running right now is interrupted: pause first if one is (pi-dispatch pause, wait for active jobs, then pi-dispatch resume)";
const PINS = `this release pins ${VALKEY_IMAGE}`;

/** `ref` when it is exactly one of `OLDER_VALKEY_IMAGES` (surrounding whitespace aside), else null. */
export function olderValkeyImage(ref) {
	const s = typeof ref === "string" ? ref.trim() : "";
	return OLDER_VALKEY_IMAGES.includes(s) ? s : null;
}

/**
 * Every `image:` of the compose file's `valkey` service (the top-level `services.valkey` block), quotes and a trailing
 * comment aside, in file order, or none. That service's only: another service on `valkey/valkey:8` (a cache an operator
 * added beside the queue, say) is the operator's choice, and a finding about it is one no upgrade step clears. A line
 * scan by indentation rather than a YAML parse, since the only question is which image the queue's Valkey names:
 * `services:` at the top, `valkey:` one level under it, and `image:` one level under that, where a nested map's
 * `image:`, a comment and a blank line are not it. A spelling the scan does not follow (a flow mapping, an anchor, a
 * quoted key) is no finding, never a false one.
 *
 * A merge left unresolved in the service (git's conflict markers at column 0, which would otherwise end the block as a
 * top-level key does) is read through: the marker lines count as blank and EVERY `image:` at the service's own level
 * counts, so a conflict between `:8` and `:8.1` is a finding, whichever side holds the older line. Under git's diff3 and
 * zdiff3 styles the merge base sits between a `|||||||` marker and the `=======`: it is neither side, so it counts as
 * blank too, and an older line in the base alone is no finding. The markers are read inside the service only; elsewhere
 * they still end the scan, as any top-level line does.
 */
function composeValkeyImages(text) {
	const lines = String(text).split(/\r?\n/);
	const depth = (line) => /^[ \t]*/.exec(line)[0].length;
	const said = (line) => !/^\s*(?:#.*)?$/.test(line);
	// git's markers: seven of one character at column 0, every one but `=======` followed by a name (a side, or the base).
	const conflictMarker = (line) => /^(?:(?:<{7}|>{7}|\|{7})(?:[ \t].*)?|={7}[ \t]*)$/.test(line);
	const baseMarker = (line) => /^\|{7}(?:[ \t].*)?$/.test(line);
	const sidesMarker = (line) => /^={7}[ \t]*$/.test(line);
	let i = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line));
	if (i < 0) return [];
	// The services, at the depth of the first one, until the next top-level key.
	let services = null;
	for (i += 1; i < lines.length; i++) {
		if (!said(lines[i])) continue;
		const d = depth(lines[i]);
		if (d === 0) return [];
		services ??= d;
		if (d === services && /^\s*valkey:\s*(?:#.*)?$/.test(lines[i])) break;
	}
	// The valkey service's own keys, at the depth of its first one, until the next service.
	const images = [];
	let keys = null;
	// Inside a conflict's merge base, from its `|||||||` to the `=======`.
	let inBase = false;
	for (i += 1; i < lines.length; i++) {
		if (baseMarker(lines[i])) inBase = true;
		else if (sidesMarker(lines[i])) inBase = false;
		if (inBase || !said(lines[i]) || conflictMarker(lines[i])) continue;
		const d = depth(lines[i]);
		if (d <= services) break;
		keys ??= d;
		const m = d === keys ? /^\s*image:\s*(["']?)([^"'\s#]+)\1\s*(?:#.*)?$/.exec(lines[i]) : null;
		if (m) images.push(m[2]);
	}
	return images;
}

/** The value of each `Image=` line of a unit file (systemd: a `#` or `;` line is a comment, the value is trimmed). */
function quadletImages(text) {
	const found = [];
	for (const line of String(text).split(/\r?\n/)) {
		const m = /^\s*Image\s*=\s*(.*?)\s*$/.exec(line);
		if (m) found.push(m[1]);
	}
	return found;
}

/** A file's text through the seam, or null when it cannot be read (absent above all). */
async function textOf(readFile, path) {
	try {
		const text = await readFile(path);
		return text === null || text === undefined ? null : String(text);
	} catch {
		return null;
	}
}

/** The verdict `valkeyContainer()` gives, synchronously or not, or null for no seam or one that throws. */
async function verdictOf(valkeyContainer) {
	if (typeof valkeyContainer !== "function") return null;
	try {
		return await valkeyContainer();
	} catch {
		return null;
	}
}

/**
 * The finding for the `pi-dispatch-valkey` container, or null: `upValkeyContainerImage` of the verdict
 * `valkeyContainer()` gives and `handedOver`, held against the older images. Exported apart for `up`, which hands it
 * the verdict of the inspect it already made and repeats this in its summary. `valkeyContainer` may answer
 * synchronously or not.
 */
export async function olderValkeyContainerFinding({ valkeyContainer, handedOver } = {}) {
	return containerFinding(await verdictOf(valkeyContainer), handedOver);
}

function containerFinding(owner, handedOver) {
	const found = olderValkeyImage(upValkeyContainerImage(owner, { handedOver }));
	if (!found) return null;
	return {
		store: "valkey-container",
		label: `the ${VALKEY_CONTAINER} container runs ${found}, the floating tag an older \`pi-dispatch up\` started it with, and keeps it until it is recreated; ${PINS}`,
		// stop, then rm, never `rm -f`: SIGTERM is what makes Valkey fsync its AOF and save a final snapshot before it exits
		// (measured on 8.0.2 and 8.1.11), where `rm -f` kills it and can lose the last second of writes to the queue.
		fix: `\`docker stop ${VALKEY_CONTAINER} && docker rm ${VALKEY_CONTAINER} && pi-dispatch up\` in the deployment folder starts ${VALKEY_IMAGE} on the same ${VALKEY_VOLUME} volume (stopped first, so Valkey writes its AOF out; the queue is kept). ${INTERRUPTS}`,
	};
}

/** The first of a compose file's valkey images (`composeValkeyImages`) that is an older one, or null. */
const olderComposeImage = (text) => composeValkeyImages(text).map(olderValkeyImage).find(Boolean) ?? null;

/**
 * Every finding for this deployment, in a fixed order: the folder's compose file, the earlier setup's copy at the
 * folder's top, the installed Quadlet unit, the container. `cwd` is the deployment folder, `home` this account's home
 * (where the Quadlet unit is installed); either missing skips its detectors. `handedOver` is whether the folder holds
 * `COMPOSE_VALKEY_OVERRIDE`, as `up` reads it. The container's verdict is asked once, and decides the compose fix too:
 * where this deployment's `up` runs the Valkey (`upRunsValkey`), the compose file only needs its line changed, since
 * recreating compose's valkey would start a second, empty Valkey beside the queue. Where compose runs it, or the verdict
 * cannot tell (no seam, a throw, a container that is not provably ours), the fix keeps the recreate.
 */
export async function olderStateFindings({ cwd, home, readFile, valkeyContainer, handedOver } = {}) {
	const findings = [];
	try {
		const owner = await verdictOf(valkeyContainer);
		if (typeof readFile === "function" && typeof cwd === "string" && cwd !== "") {
			const path = join(cwd, COMPOSE_FILE);
			const found = olderComposeImage((await textOf(readFile, path)) ?? "");
			if (found) {
				// The command /dispatch setup runs for this folder: its project, and the hand-over override where it wrote one.
				const project = composeProjectName(cwd);
				const override = (await textOf(readFile, join(cwd, COMPOSE_VALKEY_OVERRIDE))) !== null;
				const line = `change that line to \`image: ${VALKEY_IMAGE}\` (the installed package's ${COMPOSE_FILE} has it)`;
				findings.push({
					store: "valkey-compose",
					label: `${path} names ${found} for Valkey, the floating tag an older pi-dispatch shipped, which moves this host to a newer Valkey minor on its next pull; ${PINS}`,
					fix: upRunsValkey(owner, { handedOver })
						? `${line} and nothing more: this deployment's Valkey is the ${VALKEY_CONTAINER} container \`pi-dispatch up\` runs, not compose's, so recreating compose's valkey from this file would start a second, empty Valkey beside the queue`
						: `${line}, then recreate Valkey from ${cwd} with \`docker ${composeArgs({ project, override }).join(" ")} up -d valkey\` (leave out \`-p ${project}\` if you run this file without it), which stops it first, so it writes its AOF out, and keeps its volume and the queue in it. ${INTERRUPTS}`,
				});
			}
			const legacy = join(cwd, LEGACY_COMPOSE_FILE);
			const old = olderComposeImage((await textOf(readFile, legacy)) ?? "");
			if (old) {
				findings.push({
					store: "valkey-compose",
					label: `${legacy} names ${old} for Valkey, the floating tag an older pi-dispatch shipped; ${PINS}`,
					fix: `that file is an earlier /dispatch setup's copy, which setup no longer runs (${COMPOSE_FILE} is the one, and this copy's ../ paths reach the folder above ${cwd}): move any edits of yours there and remove it, or, if you still run it, change that line to \`image: ${VALKEY_IMAGE}\``,
				});
			}
		}
		if (typeof readFile === "function" && typeof home === "string" && home !== "") {
			const path = join(quadletDir(home), QUADLET_FILES.valkey.file);
			const found = quadletImages((await textOf(readFile, path)) ?? "").map(olderValkeyImage).find(Boolean);
			if (found) {
				findings.push({
					store: "valkey-quadlet",
					label: `${path} runs Valkey as ${found}, the floating tag an older pi-dispatch installed; this release pins docker.io/${VALKEY_IMAGE}`,
					fix: `\`pi-dispatch service install --force\` in the deployment folder rewrites the unit and restarts ${QUADLET_FILES.valkey.unit} on the same ${VALKEY_VOLUME} volume (stopped first, so Valkey writes its AOF out; the queue is kept); \`pi-dispatch up\` leaves a changed unit file as it is. ${INTERRUPTS}`,
				});
			}
		}
		const container = containerFinding(owner, handedOver);
		if (container) findings.push(container);
	} catch {
		// Nothing above throws by design (every read goes through a guarded seam); a finding already made still stands.
	}
	return findings;
}
