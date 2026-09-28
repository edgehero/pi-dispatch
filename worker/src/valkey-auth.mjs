/**
 * The password of the Valkey pi-dispatch starts (issue #468).
 *
 * Loopback is shared by every account on a host. #464 stops one account from ADOPTING another's Valkey by accident;
 * it does nothing about a co-tenant who connects on purpose, and a Valkey with no password lets any local account read
 * the queued jobs (their task text, their repositories), enqueue work another account's worker runs with that
 * account's provider key and forge credentials, and delete the queue. So every deployment's Valkey gets a password of
 * its own, generated once, kept in the deployment's `.env` as `VALKEY_PASSWORD`.
 *
 * A key of its own, NOT a password inside VALKEY_URL: VALKEY_URL is printed by doctor, written into the admin's
 * deployment pointer (which by contract never carries a credential) and quoted in refusals, so a URL that carried the
 * password would be a credential in every one of those places. A separate key stays out of all of them, and doctor
 * says only whether it is set. An operator's own VALKEY_URL with its own userinfo (a managed Valkey, TLS) is left as it
 * is, and its password wins over this key (`connection.mjs`).
 *
 * HOW THE VALKEY LEARNS IT, measured on Podman 5.8.1 (Fedora 44) and 4.9.3 (Ubuntu 24.04) with valkey/valkey:8
 * (Valkey 8.1.10): the image runs `tini -- docker-entrypoint.sh <command>`, and tini keeps its whole argv as PID 1 for
 * the life of the container, so `valkey-server --requirepass X` put the password in a /proc/<pid>/cmdline that another
 * account read, on the host, for as long as the Valkey ran (the pid namespace hides nothing: /proc of the host lists
 * the container's processes, and cmdline is world-readable). The image's VALKEY_EXTRA_FLAGS only appends to that same
 * argv. So the password travels in the container's ENVIRONMENT (a Quadlet `EnvironmentFile=` of a 0600 file, compose's
 * `environment:`, `docker run -e VALKEY_PASSWORD` with the value in the CLI's own environment), which /proc shows only
 * to the account itself, and `VALKEY_START_SCRIPT` hands it to valkey-server as CONFIGURATION ON STDIN (`valkey-server
 * -`): written to a 0600 temp file by the shell's own `echo` builtin (no process, so no argv), opened as stdin, deleted,
 * then the image's entrypoint runs as it always did (its chown and its drop to the `valkey` user), and valkey-server
 * reads the one `requirepass` line from the open descriptor. Measured: an account scanning every /proc/<pid>/cmdline
 * during start and at rest saw no password, and nothing is left in the container's /tmp. With VALKEY_PASSWORD empty or
 * unset the same script starts Valkey with no password, exactly as before, so an older `.env` keeps working.
 *
 * `$` and `%` are the two characters the script must survive in three carriers: systemd expands `$X` and `%x` in the
 * ExecStart Quadlet generates, and compose interpolates `$X`. The script has no `%` and no backslash, and every `$` is
 * written `$$` in the Quadlet unit and the compose file (`dollarsDoubled`), and a test reads each carrier's copy back and
 * holds all three equal to this constant.
 */
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

/** The `.env` key (issue #468). */
export const VALKEY_PASSWORD_KEY = "VALKEY_PASSWORD";

/**
 * A new password: 32 random bytes as 64 lowercase hex characters. Hex because every loader of `.env` reads it back
 * byte for byte (systemd, the shells, the cmd wrapper split on `=`), nothing in it is special to a Valkey config line,
 * a URL or a shell, and it matches the WEBHOOK_SECRET `up` already generates.
 */
export function newValkeyPassword(random = randomBytes) {
	return random(32).toString("hex");
}

/**
 * What is wrong with `value` as a Valkey password this project hands to valkey-server, or null. Only base64url
 * characters (A-Z a-z 0-9 - _), 16 to 512 of them: the start script writes it into a Valkey config line, where a space,
 * a quote or a `#` would change what the line says, and `.env` must read it back the same under every loader.
 */
export function valkeyPasswordProblem(value) {
	if (typeof value !== "string" || value === "") return "it is empty";
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return "it has a character other than A-Z, a-z, 0-9, - and _, which the Valkey start script and every .env loader cannot all read the same";
	if (value.length < 16) return `it is ${value.length} characters long, and a password this project hands to Valkey needs at least 16`;
	if (value.length > 512) return `it is ${value.length} characters long, over the 512 this project accepts`;
	return null;
}

/** The sentence that tells an operator how to make a good one. */
export const VALKEY_PASSWORD_HOWTO = "`openssl rand -hex 32` makes one, or remove the line and let `pi-dispatch up` or `service install` generate it";

/**
 * The container command that starts Valkey with the password from its environment, as configuration on stdin (see the
 * header). One copy, in three carriers: `deploy/pi-dispatch-valkey.container`'s Exec=, `deploy/docker-compose.yml`'s
 * command, and `valkeyDockerRunArgs` (`up` and doctor's fix). `--appendonly yes` as before (REQ-QUEUE-BURST-NO-DROP).
 */
export const VALKEY_START_SCRIPT =
	'set -eu; if [ -n "${VALKEY_PASSWORD:-}" ]; then umask 077; f=$(mktemp); echo "requirepass $VALKEY_PASSWORD" >"$f"; exec 0<"$f"; rm -f "$f"; set -- -; else set --; fi; unset VALKEY_PASSWORD; exec docker-entrypoint.sh valkey-server "$@" --appendonly yes';

/**
 * The health check, run by the container runtime through `/bin/sh -c`: healthy only when Valkey answers PONG to this
 * deployment's own password (REDISCLI_AUTH, which valkey-cli reads from its environment, never an argv). A bare
 * `valkey-cli ping` was measured to exit 0 on `NOAUTH Authentication required.`, so it could not tell a Valkey that
 * refuses its own password from a healthy one.
 */
export const VALKEY_HEALTH_SCRIPT = 'if [ -n "${VALKEY_PASSWORD:-}" ]; then REDISCLI_AUTH="$VALKEY_PASSWORD"; export REDISCLI_AUTH; fi; valkey-cli ping | grep -q PONG';

/** The Quadlet and compose spelling of a script: every `$` doubled, which each carrier reads back as one. */
export function dollarsDoubled(script) {
	return script.replaceAll("$", () => "$$");
}

/**
 * `deploy/docker-compose.yml`'s Valkey, as one `docker run` (`up`'s docker step and doctor's fix), published on `port`. `-e VALKEY_PASSWORD`
 * names the variable only: the docker CLI takes its value from its OWN environment (the caller's spawn env), so the
 * password is on no argv. Same image, AOF on, loopback only, the named volume, the health check above.
 */
export function valkeyDockerRunArgs({ port = 6379, deployment = null } = {}) {
	return [
		"run",
		"-d",
		"--name",
		"pi-dispatch-valkey",
		// Whose Valkey this is (PR #475's review, round 3): the deployment folder's real path, so a later `up`, the wizard's
		// hand-over or a password restart acts on it only from that folder (`valkeyContainerIsOurs`).
		...(deployment ? ["--label", `${DEPLOYMENT_LABEL}=${deployment}`] : []),
		"--restart",
		"unless-stopped",
		"-p",
		// VALKEY_URL's port on 127.0.0.1 (the container listens on 6379 inside), as the Quadlet unit's PublishPort= is.
		`127.0.0.1:${port}:6379`,
		"-v",
		"pi-dispatch-valkey-data:/data",
		"-e",
		VALKEY_PASSWORD_KEY,
		"--health-cmd",
		VALKEY_HEALTH_SCRIPT,
		"--health-interval",
		"10s",
		"--health-timeout",
		"3s",
		"--health-retries",
		"5",
		"valkey/valkey:8",
		"sh",
		"-c",
		VALKEY_START_SCRIPT,
	];
}

/**
 * The 0600 file the Quadlet Valkey reads its password from (`EnvironmentFile=%h/.config/pi-dispatch/valkey.env`): the
 * one key, nothing else of the deployment's `.env` (whose provider key and forge credentials the Valkey container has no
 * use for). Empty value for a deployment with no password, which the start script reads as "start without one".
 */
export function valkeyEnvFileText(password) {
	return `# Written by pi-dispatch (service install / up) from VALKEY_PASSWORD in the deployment's .env; mode 0600.\n${VALKEY_PASSWORD_KEY}=${password ?? ""}\n`;
}

/**
 * Whether a VALKEY_URL is one pi-dispatch generates a password for: its host is this machine's loopback (unset is the
 * default, 127.0.0.1) and it carries no userinfo. A URL naming another host, or carrying its own credentials, is the
 * operator's own Valkey and is left as it is.
 */
export function managedValkeyUrl(url) {
	if (url === undefined || url === null || url === "") return true;
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return false;
	}
	if (u.username !== "" || u.password !== "") return false;
	return isLoopbackHost(u.hostname);
}

/** A loopback host as a client dials it: 127.0.0.0/8, ::1 (bracketed or not), `localhost`, or an unspecified address. */
export function isLoopbackHost(hostname) {
	const h = String(hostname ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
	if (h === "localhost" || h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
	if (/^::ffff:(127|0)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	return /^(127|0)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The refusal for a Valkey that rejected this client's credential, or null for any other error: NOAUTH (it requires a
 * password and none was sent), WRONGPASS or "invalid password" (one was sent and it is not that Valkey's). `from` is
 * where the password that was sent came from (`valkeyPasswordFor`), `envPath` the deployment `.env`; the sentence names
 * the key and its source, never a value.
 */
export function valkeyAuthRefusal(err, { passwordSet, from = null, envPath = "the deployment's .env" } = {}) {
	const text = String(err?.message ?? err ?? "");
	if (/\bNOAUTH\b/.test(text) && !passwordSet) {
		return `the Valkey VALKEY_URL reaches requires a password, and this deployment sets none: put ${VALKEY_PASSWORD_KEY}=<that Valkey's password> in ${envPath} (a Valkey shared with PI_VALKEY_SHARED=1 takes the password of the account that runs it)`;
	}
	if (/\bWRONGPASS\b|invalid password|\bNOAUTH\b/i.test(text)) {
		const source = from === "VALKEY_URL" ? "the password in VALKEY_URL" : `${VALKEY_PASSWORD_KEY} from ${from ?? envPath}`;
		return `the Valkey VALKEY_URL reaches refused ${source} (${/\bNOAUTH\b/.test(text) ? "NOAUTH" : "WRONGPASS"}): it is not that Valkey's password. After changing ${VALKEY_PASSWORD_KEY}, restart Valkey with it (\`pi-dispatch up\`, or \`pi-dispatch service install --force\` on the podman venue), then the worker and the receiver`;
	}
	return null;
}

/**
 * Whether `service install` or `up` generates a password for this deployment (issue #468), from its `.env` keys as the
 * service reads them (`readValkeyKeys`). Returns `{ password, generate, note }` or `{ error }`:
 *   - VALKEY_PASSWORD set: kept, never replaced (a rotation is the operator's edit), and refused when the start script
 *     could not hand it to Valkey (`valkeyPasswordProblem`);
 *   - PI_VALKEY_SHARED=1: none generated. The shared Valkey is another account's, and its password is that account's
 *     to give; one made here would reach no Valkey;
 *   - a VALKEY_URL that is not this machine's loopback, or that carries its own userinfo: none generated, the
 *     operator's own Valkey left as it is;
 *   - otherwise `generate`: a new one goes into `.env` (never over a value) and into the Valkey the command starts.
 */
export function valkeyPasswordDecision(keys, { envPath = ".env" } = {}) {
	const current = keys?.[VALKEY_PASSWORD_KEY];
	if (typeof current === "string" && current !== "") {
		const problem = valkeyPasswordProblem(current);
		if (problem) return { error: `${VALKEY_PASSWORD_KEY} in ${envPath} cannot be handed to Valkey: ${problem}. ${VALKEY_PASSWORD_HOWTO}` };
		return { password: current, generate: false, note: null };
	}
	if (keys?.PI_VALKEY_SHARED === "1") {
		return { password: null, generate: false, note: `PI_VALKEY_SHARED=1 in ${envPath}: no ${VALKEY_PASSWORD_KEY} is generated, since the shared Valkey is another account's. Put that Valkey's password in ${VALKEY_PASSWORD_KEY} in ${envPath}` };
	}
	if (!managedValkeyUrl(keys?.VALKEY_URL)) {
		return { password: null, generate: false, note: `VALKEY_URL in ${envPath} names your own Valkey (another host, or a URL with its own credentials): no ${VALKEY_PASSWORD_KEY} is generated for it` };
	}
	return { password: null, generate: true, note: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The compose file's Valkey, as `up` and the setup wizard drive it (PR #475's review)
// ---------------------------------------------------------------------------------------------------------------------

/** The shipped compose file and the wizard's hand-over override, relative to the deployment folder. */
export const COMPOSE_FILE = "deploy/docker-compose.yml";
export const COMPOSE_VALKEY_OVERRIDE = "deploy/docker-compose.valkey.yml";

/**
 * The compose project name of a deployment folder: its basename, normalised as compose v2 normalises a directory name
 * (lower case, only a-z 0-9 _ -, no leading _ or -; measured with compose 2.31 and 5.5.1: "My Deploy.v2_x" is
 * "mydeployv2_x"). A name with none of those characters left ("日本") is one compose itself refuses ("project name must
 * not be empty", measured), and is "pi-dispatch" here. Compose names a project after the directory of its FIRST file,
 * `deploy/` in every folder the wizard lays out, so `-p` is what keeps the folder's own project.
 */
export function composeProjectName(dir) {
	const name = basename(String(dir)).toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[_-]+/, "");
	return name === "" ? "pi-dispatch" : name;
}

/**
 * The start of every compose command for a deployment folder, run FROM that folder: `-p` when a project is named (a
 * folder the wizard laid out), `--env-file .env` (VALKEY_PASSWORD, issue #468), the shipped file, and the hand-over
 * override when the folder has one.
 */
export function composeArgs({ project = null, override = false } = {}) {
	return ["compose", ...(project ? ["-p", project] : []), "--env-file", ".env", "-f", COMPOSE_FILE, ...(override ? ["-f", COMPOSE_VALKEY_OVERRIDE] : [])];
}

/**
 * The environment compose's Valkey reads its published port from (PR #475's review): `PI_VALKEY_PORT`, VALKEY_URL's
 * port, so the queue stays where the worker dials it (the compose file said 6379 whatever VALKEY_URL said, and a
 * hand-over moved a 16495 deployment's queue to 6379, measured). The compose file reads it as `${PI_VALKEY_PORT:-6379}`.
 */
export const VALKEY_PORT_KEY = "PI_VALKEY_PORT";

/**
 * The compose override the wizard writes when `up` already runs the deployment's Valkey: compose's own `valkey`
 * service mounts `up`'s volume, `pi-dispatch-valkey-data`, instead of a project volume of its own. Written once,
 * create-only; `up` and every later command for the folder name it.
 */
export const VALKEY_HANDOVER_OVERRIDE = `# Written by /dispatch setup (the docker compose answer): this deployment's Valkey was the one \`pi-dispatch up\`
# started (container pi-dispatch-valkey, volume pi-dispatch-valkey-data). compose's valkey service takes over that
# VOLUME, so the worker and the receiver container (valkey:6379) use one Valkey and one queue. \`pi-dispatch up\` starts
# this Valkey (with -p <this folder's project> and this file) whenever the folder has it.
services:
  valkey:
    volumes:
      - pi-dispatch-valkey-data:/data
volumes:
  pi-dispatch-valkey-data:
    external: true
`;

// ---------------------------------------------------------------------------------------------------------------------
// Whose Valkey container and volume (PR #475's review, round 3: THE simpler rule)
// ---------------------------------------------------------------------------------------------------------------------

/** The label `up` puts on the Valkey container it creates: the deployment folder's real path. */
export const DEPLOYMENT_LABEL = "com.pi-dispatch.deployment";

/** The named volume `up`'s Valkey (and a handed-over compose Valkey) keeps its AOF on. */
export const VALKEY_VOLUME = "pi-dispatch-valkey-data";

/**
 * Whether a container (one record of `docker container inspect`) is PROVABLY this deployment's Valkey. Nothing ever
 * stops, removes, reuses or mounts beside a container this answers false for: the review found the wizard's hand-over
 * removing another deployment's Valkey, and `up` starting a second Valkey on one AOF, both from treating a name or a
 * volume as proof of ownership. Proof is one of:
 *   - `up`'s label, `com.pi-dispatch.deployment`, equal to this deployment folder (`dirs`: its real path and as given);
 *   - compose's own `com.docker.compose.project.working_dir`, this folder or its `deploy/` (a compose Valkey of this
 *     folder, the hand-over's included);
 *   - for a legacy, unlabelled `pi-dispatch-valkey` only: it publishes this deployment's VALKEY_URL port on 127.0.0.1,
 *     up's own rule since #464 (it is the Valkey this deployment's worker dials).
 */
export function valkeyContainerIsOurs(info, { dirs, port }) {
	const labels = info?.Config?.Labels ?? {};
	const mine = new Set(dirs.filter(Boolean).flatMap((d) => [d, join(d, "deploy")]));
	if (typeof labels[DEPLOYMENT_LABEL] === "string") return mine.has(labels[DEPLOYMENT_LABEL]);
	const wd = labels["com.docker.compose.project.working_dir"];
	if (typeof wd === "string") return mine.has(wd);
	const name = String(info?.Name ?? "").replace(/^\//, "");
	if (name !== "pi-dispatch-valkey") return false;
	return publishedPorts(info).includes(Number(port));
}

/** The host ports a container publishes its 6379 on, from its inspect record (HostConfig, else NetworkSettings). */
function publishedPorts(info) {
	const bindings = info?.HostConfig?.PortBindings?.["6379/tcp"] ?? info?.NetworkSettings?.Ports?.["6379/tcp"] ?? [];
	return (Array.isArray(bindings) ? bindings : []).filter((b) => !b?.HostIp || b.HostIp === "127.0.0.1").map((b) => Number(b?.HostPort)).filter(Number.isInteger);
}

/** Who a container belongs to, as a refusal names it: its label, compose's working dir, or what it publishes. */
function ownerShown(info) {
	const labels = info?.Config?.Labels ?? {};
	if (labels[DEPLOYMENT_LABEL]) return `the deployment in ${labels[DEPLOYMENT_LABEL]}`;
	if (labels["com.docker.compose.project.working_dir"]) return `the compose project in ${labels["com.docker.compose.project.working_dir"]}`;
	const ports = publishedPorts(info);
	return ports.length > 0 ? `unlabelled, publishing 127.0.0.1:${ports.join(", ")}` : "unlabelled, publishing nothing on 127.0.0.1";
}

/**
 * One container by name: `{ absent }`, `{ ours, owner }`, or `{ unknown }` when docker did not answer (which is never
 * taken as ours). `query(cmd, args)` resolves `{ code, stdout, stderr }`.
 */
export async function valkeyContainerOwner(name, { dirs, port, query }) {
	const res = await query("docker", ["container", "inspect", name]);
	if (res.code !== 0) return /no such (container|object)/i.test(String(res.stderr ?? "")) ? { absent: true } : { unknown: `docker container inspect ${name} exited ${res.code}` };
	let info;
	try {
		info = JSON.parse(String(res.stdout))[0];
	} catch {
		return { unknown: `docker container inspect ${name} printed no record` };
	}
	return { ours: valkeyContainerIsOurs(info, { dirs, port }), owner: ownerShown(info) };
}

/**
 * The containers that mount `pi-dispatch-valkey-data` and are NOT provably this deployment's (PR #475's review, round
 * 3). Asked before anything starts a Valkey on that volume: two valkey-servers appending to one AOF corrupt both queues
 * (measured: a second deployment's `up` ran pi-dispatch-valkey on the volume a handed-over compose Valkey mounted, and
 * both appended to /data/appendonlydir). `{ foreign: [{ name, owner }] }`, or `{ unknown }` when docker could not be
 * asked, which callers refuse on too.
 */
export async function foreignVolumeUsers({ dirs, port, query }) {
	const ps = await query("docker", ["ps", "-a", "--filter", `volume=${VALKEY_VOLUME}`, "--format", "{{.Names}}"]);
	if (ps.code !== 0) return { unknown: `docker ps -a --filter volume=${VALKEY_VOLUME} exited ${ps.code}` };
	const foreign = [];
	for (const name of String(ps.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
		const who = await valkeyContainerOwner(name, { dirs, port, query });
		if (who.absent) continue;
		if (who.unknown) foreign.push({ name, owner: who.unknown });
		else if (!who.ours) foreign.push({ name, owner: who.owner });
	}
	return { foreign };
}

/** The refusal for a volume another deployment's Valkey mounts, naming it and the ways out. */
export function foreignVolumeRefusal(check) {
	if (check.unknown) return `whether another Valkey mounts ${VALKEY_VOLUME} could not be read (${check.unknown}), so no Valkey is started on it`;
	const names = check.foreign.map((f) => `${f.name} (${f.owner})`).join(", ");
	return `${VALKEY_VOLUME} is mounted by ${names}, which is not this deployment's Valkey: a second Valkey on the same AOF would corrupt both queues, so none is started. Stop that deployment's Valkey first if this folder should own the volume, or give this deployment a Valkey of its own (compose in this folder without deploy/docker-compose.valkey.yml keeps its own volume)`;
}

/** The refusal for a `pi-dispatch-valkey` container that is not this deployment's: never stopped, removed or reused. */
export function foreignContainerSentence(name, owner) {
	return `${name} is not this deployment's Valkey (${owner}), so it is never stopped, removed or reused from here`;
}

/**
 * What `.env` should say about PI_VALKEY_PORT for a deployment whose VALKEY_URL names `port` (PR #475's review, round
 * 3): the port lived only in the env `up` and the wizard hand compose, so a plain `docker compose up -d` in the folder
 * published its Valkey on 6379 while the worker dialled the URL's port. `assigned` is the value `.env` holds, or
 * undefined. `{ write }` where the port is not 6379 and `.env` names none, `{ conflict }` (a sentence) where `.env`
 * names another port, never overwritten; else `{}`.
 */
export function valkeyPortEnvDecision(assigned, port, { envPath = ".env" } = {}) {
	const have = typeof assigned === "string" ? assigned.trim() : "";
	if (have === "") return Number(port) === 6379 ? {} : { write: String(port) };
	if (have === String(port)) return {};
	return { conflict: valkeyPortConflict(have, port, envPath) };
}

/** The sentence for a PI_VALKEY_PORT that disagrees with VALKEY_URL's port (shared by `up`, the wizard and doctor). */
export function valkeyPortConflict(assigned, port, envPath = ".env") {
	return `${VALKEY_PORT_KEY} is ${assigned} in ${envPath}, and VALKEY_URL's port is ${port}: compose publishes its Valkey on ${assigned}, where the worker does not dial. Set ${VALKEY_PORT_KEY}=${port} there (or remove it when the port is 6379); it is never overwritten from here`;
}

/**
 * The wizard's hand-over question under the ownership rule (PR #475's review, round 3), here so the rule is one function
 * both the wizard and a test on a real docker run. `{ handover, note }` or `{ refused }`:
 *   - `pi-dispatch-valkey` is handed to compose only when it is PROVABLY this deployment's (`valkeyContainerIsOurs`);
 *     one that is another deployment's is never stopped or removed (measured: the hand-over removed another
 *     deployment's Valkey and cut its worker off), and `note` names it;
 *   - where compose's valkey would mount `pi-dispatch-valkey-data` (the override on disk, or a hand-over), a container
 *     on that volume that is not this deployment's refuses the whole step (`foreignVolumeRefusal`), and so does a
 *     volume labelled for another folder; an unlabelled one is taken as this deployment's where its own
 *     pi-dispatch-valkey serves it (the hand-over), else `adopt` asks the caller to get consent first;
 *   - docker not answering is a refusal, never a guess.
 * The started Valkey's `pi-dispatch:owner` marker is the caller's to check (`claimValkeyOwner`, connection.mjs).
 */
export async function composeHandoverPlan({ dirs, port, override, query }) {
	const who = await valkeyContainerOwner("pi-dispatch-valkey", { dirs, port, query });
	if (who.unknown) return { refused: `whether pi-dispatch-valkey is this deployment's could not be read (${who.unknown}), so nothing is stopped or started` };
	const handover = who.ours === true;
	const note = who.ours === false ? `${foreignContainerSentence("pi-dispatch-valkey", who.owner)}; it is left running` : null;
	if (override || handover) {
		const check = await foreignVolumeUsers({ dirs, port, query });
		if (check.unknown || check.foreign.length > 0) return { refused: foreignVolumeRefusal(check) };
		// The volume's own owner (the volume gap): another folder's label is never used; an unlabelled one is this
		// deployment's when this deployment's own pi-dispatch-valkey serves it now (the hand-over), else only with consent.
		const volume = await valkeyVolumeOwner({ dirs, query });
		if (volume.unknown) return { refused: `whose ${VALKEY_VOLUME} is could not be read (${volume.unknown}), so nothing is stopped or started` };
		if (volume.ours === false) return { refused: foreignVolumeLabelRefusal(volume.owner) };
		if (volume.unlabelled && !handover) return { handover, note, adopt: true };
	}
	return { handover, note };
}

/** The key inside a Valkey that records which deployment folder its queue is (PR #475's review, round 3's close). */
export const OWNER_MARKER_KEY = "pi-dispatch:owner";

/**
 * `docker volume create` for `pi-dispatch-valkey-data`, labelled with the deployment folder that creates it (PR #475's
 * review): a volume label cannot be changed afterwards, so the one that creates it names its owner once, for good.
 */
export function valkeyVolumeCreateArgs(deployment) {
	return ["volume", "create", "--label", `${DEPLOYMENT_LABEL}=${deployment}`, VALKEY_VOLUME];
}

/**
 * Whose `pi-dispatch-valkey-data` is (PR #475's review, the volume gap: after one deployment's compose Valkey was taken
 * down, nothing mounted the volume, and a second deployment's `up` started on the first one's queue). `{ absent }`,
 * `{ ours, owner }` by its label (exactly this folder, as given or real), `{ unlabelled }` for a volume made before the
 * label (or by hand), which is used only with consent that `--yes` does not give, or `{ unknown }`.
 */
export async function valkeyVolumeOwner({ dirs, query }) {
	const res = await query("docker", ["volume", "inspect", VALKEY_VOLUME]);
	if (res.code !== 0) return /no such volume|not found/i.test(String(res.stderr ?? "")) ? { absent: true } : { unknown: `docker volume inspect ${VALKEY_VOLUME} exited ${res.code}` };
	let info;
	try {
		info = JSON.parse(String(res.stdout))[0];
	} catch {
		return { unknown: `docker volume inspect ${VALKEY_VOLUME} printed no record` };
	}
	const label = info?.Labels?.[DEPLOYMENT_LABEL];
	if (typeof label !== "string" || label === "") return { unlabelled: true };
	return { ours: dirs.filter(Boolean).includes(label), owner: label };
}

/** The refusal for a volume labelled for another folder: never used from here. */
export function foreignVolumeLabelRefusal(owner) {
	return `${VALKEY_VOLUME} belongs to the deployment in ${owner} (its label), so this deployment never uses it: give this deployment a Valkey of its own (compose in this folder without deploy/docker-compose.valkey.yml keeps its own volume), or run this from ${owner}`;
}

/** The question for an unlabelled volume, asked even under --yes: what adopting it means. */
export function adoptVolumeQuestion(deployment) {
	return `${VALKEY_VOLUME} exists without an owner label: this volume holds a queue pi-dispatch cannot attribute to a folder. Starting this deployment's Valkey on it makes that queue this deployment's (recorded inside it as ${OWNER_MARKER_KEY}); if another deployment used it, its waiting jobs would run here. Adopt it for ${deployment}? (asked even under --yes) [y/N] `;
}

/** The refusal for an unlabelled volume that was not adopted. */
export function unadoptedVolumeRefusal() {
	return `${VALKEY_VOLUME} has no owner label and was not adopted (this volume holds a queue pi-dispatch cannot attribute to a folder), so no Valkey is started on it. Answer y when asked (--yes does not), or give this deployment a Valkey of its own (compose in this folder without deploy/docker-compose.valkey.yml keeps its own volume)`;
}

/** The refusal for a Valkey whose owner marker names another folder. */
export function foreignMarkerRefusal(owner) {
	return `the queue on ${VALKEY_VOLUME} is the deployment's in ${owner} (${OWNER_MARKER_KEY} inside it), not this one's`;
}
