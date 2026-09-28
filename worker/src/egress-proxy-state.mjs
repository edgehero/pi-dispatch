/**
 * THE SHIPPED EGRESS PROXY'S STATE, read one way by `up` and `doctor` on the docker venue (issue #453, gate rounds 1
 * and 2).
 *
 * Two questions, both answered from one `docker inspect`:
 *   - RUNNING is `{{.State.Status}}` === "running". Measured on Docker Engine 29.8.1: a paused container reads
 *     `paused` with `.State.Running` TRUE, and one a restart policy is cycling reads `restarting` with `.State.Running`
 *     TRUE (39 of 40 samples); Podman reports a paused one `paused` with Running false and one between restarts
 *     `stopped` (4.9.3 and 5.8.1). Only the status word tells them from a proxy that carries traffic.
 *   - CURRENT: a container of the shipped name made from another image (an older squid digest), with another
 *     entrypoint or command, or with other files mounted, is not the proxy this deployment ships, and `docker start`
 *     of it, or a "present" that leaves it running, keeps that policy. Compared: the image's digest, the entrypoint and
 *     command against the pinned image's own (read from its registry config, identical on every platform in the
 *     manifest list), and the mounts: the two bind sources against this folder's `deploy/egress-proxy.conf` and
 *     `egress-allowlist.conf`, the image's two anonymous volumes allowed, anything else stale.
 *
 * MEASURED (Docker Engine 29.8.1, compose 5.5.1, rootful, gate round 2; pinned in egress-proxy-state.test.mjs): a proxy
 * made by `docker compose --profile egress up -d` and one made by `up`'s argv carry the pinned reference exactly as
 * written, the image's own entrypoint and command, the two binds and the image's two anonymous volumes; a folder
 * reached through a symlink is reported by the symlink's path, which the realpath below makes the same folder.
 *
 * THE MOUNTS ARE COMPARED WHERE THEY CAN BE. A runtime that reports a source as a path of its own VM (Docker Desktop's
 * `/host_mnt/...` and `/run/desktop/mnt/host/...`, not measured here) gives sources nothing here can resolve, and
 * calling that proxy stale would have doctor fail forever and `up --yes` remove a healthy proxy on every run. So a
 * source under one of those prefixes, or any unresolvable source on a macOS or Windows host, makes the mount
 * comparison UNKNOWN, said as such and never the ground for a removal. On a Linux host an unresolvable source is gone,
 * and that proxy is stale. The image, entrypoint and command are compared either way.
 *
 * Only the SHIPPED name is judged current or stale: a container `PI_EGRESS_PROXY` names is the operator's own.
 */
import { resolve } from "node:path";

/** The pinned squid, as `deploy/docker-compose.yml` and `up`'s run argv name it (a test binds the three). */
export const EGRESS_PROXY_IMAGE = "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029";

/**
 * The pinned image's own entrypoint and command, and its anonymous volumes, from its registry config (read on
 * 2026-09-27 for every linux platform in the manifest list: amd64, arm64, ppc64le, s390x, all identical). Neither
 * compose nor `up` sets either, so a container made by them carries these.
 */
export const EGRESS_PROXY_ENTRYPOINT = Object.freeze(["entrypoint.sh"]);
export const EGRESS_PROXY_CMD = Object.freeze(["-f", "/etc/squid/squid.conf", "-NYC"]);
const IMAGE_VOLUMES = Object.freeze(["/var/log/squid", "/var/spool/squid"]);

/** Where Docker Desktop reports a bind source from its own VM (not measured here; the documented shapes). */
const VM_PREFIXES = Object.freeze(["/host_mnt/", "/run/desktop/mnt/host/"]);

/**
 * The inspect format both callers use: one JSON object, so no field can be split on a separator a path might hold.
 * `health` is doctor's advisory line; the rest is this module's.
 */
export const PROXY_STATE_FORMAT =
	'--format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}';

/** Where the proxy's two files are mounted inside it (compose's and `up`'s mounts alike). */
const SQUID_CONF = "/etc/squid/squid.conf";
const ALLOWLIST = "/etc/pi-dispatch/allowlist.conf";

/**
 * `{ status, health, image, entrypoint, cmd, mounts, networks }` from `PROXY_STATE_FORMAT`'s stdout, or null when it
 * is not that shape. `mounts` is the list as `[{ type, source, destination }]`, `networks` the attached names.
 */
export function parseProxyState(stdout) {
	let body;
	try {
		body = JSON.parse(String(stdout ?? "").trim());
	} catch {
		return null;
	}
	if (!body || typeof body !== "object" || typeof body.status !== "string" || !/^[a-z]{1,20}$/.test(body.status)) return null;
	// An argv as a list. Podman 4.9.3's native inspect renders `.Config.Entrypoint` as a STRING (`"entrypoint.sh"`, and
	// `""` for none; measured, gate round 3), where Docker Engine 29.8.1 and Podman 5.8.1 (native and through its Docker
	// API) render a list; docker renders none as `null`. Each is normalised, so a correctly shipped proxy never reads
	// stale on the runtime's spelling.
	const strings = (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : typeof v === "string" ? (v === "" ? [] : [v]) : v === null || v === undefined ? [] : null);
	return {
		status: body.status,
		// Podman's Docker API answers "" where docker's template says "none" (measured, 5.8.1): both are "no healthcheck".
		health: typeof body.health === "string" && body.health !== "" ? body.health : "none",
		image: typeof body.image === "string" ? body.image : "",
		entrypoint: strings(body.entrypoint),
		cmd: strings(body.cmd),
		mounts: (Array.isArray(body.mounts) ? body.mounts : []).filter((m) => m && typeof m === "object").map((m) => ({ type: String(m.Type ?? ""), source: String(m.Source ?? ""), destination: String(m.Destination ?? "") })),
		networks: body.networks && typeof body.networks === "object" ? Object.keys(body.networks) : [],
	};
}

/** The digest an image reference pins, or null. */
function digestOf(image) {
	return /@(sha256:[0-9a-f]{64})$/.exec(String(image ?? ""))?.[1] ?? null;
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What makes a container of the shipped name not this deployment's proxy, as `{ drift, unknown }`: `drift` the
 * sentences that make it stale, `unknown` why the mounts could not be compared here (null when they were).
 * `realpath` throws for a path that does not resolve on this host. `compareMounts: false` judges the image, entrypoint and
 * command alone, for a caller that does not know which folder the service uses. `platform` decides whether a source
 * that does not resolve can be a path of the runtime's own VM (below).
 */
export function shippedProxyDrift(state, { cwd, realpath = (p) => p, compareMounts = true, platform = "linux" }) {
	const drift = [];
	if (digestOf(state.image) !== digestOf(EGRESS_PROXY_IMAGE)) drift.push(`it was created from ${state.image || "an unnamed image"}, not the pinned ${EGRESS_PROXY_IMAGE}`);
	if (!sameList(state.entrypoint, EGRESS_PROXY_ENTRYPOINT)) drift.push(`its entrypoint is ${JSON.stringify(state.entrypoint)}, not the image's ${JSON.stringify(EGRESS_PROXY_ENTRYPOINT)}`);
	if (!sameList(state.cmd, EGRESS_PROXY_CMD)) drift.push(`its command is ${JSON.stringify(state.cmd)}, not the image's ${JSON.stringify(EGRESS_PROXY_CMD)}`);
	if (!compareMounts) return { drift, unknown: null };
	const binds = state.mounts.filter((m) => m.type === "bind");
	const resolves = (source) => {
		try {
			realpath(source);
			return true;
		} catch {
			return false;
		}
	};
	// UNKNOWN only where a source can be a path of the runtime's own VM: under a VM prefix Docker Desktop is known to use,
	// or on a macOS or Windows host, where every Linux daemon runs in a VM (gate round 3's simple rule). On a Linux host a
	// source that does not resolve is simply gone (its folder deleted, say), and a proxy mounting nothing real is stale.
	// EACH BIND ON ITS OWN (round-cap re-review): an unknown one is unknown for itself, and the other expected bind and
	// every extra mount are still compared; a caller refuses a removal only while an EXPECTED bind is unknown.
	const vmPath = (source) => VM_PREFIXES.some((prefix) => source.startsWith(prefix)) || platform === "darwin" || platform === "win32";
	const expected = { [SQUID_CONF]: resolve(cwd, "deploy/egress-proxy.conf"), [ALLOWLIST]: resolve(cwd, "egress-allowlist.conf") };
	const same = (source, want) => {
		try {
			return source === want || realpath(source) === realpath(want);
		} catch {
			return false;
		}
	};
	const unknownSources = [];
	for (const [destination, want] of Object.entries(expected)) {
		const bind = binds.find((m) => m.destination === destination);
		if (!bind) drift.push(`nothing is mounted at ${destination}, where ${want} belongs`);
		else if (!resolves(bind.source) && vmPath(bind.source)) unknownSources.push(bind.source);
		else if (!resolves(bind.source)) drift.push(`its ${destination} is ${bind.source}, which does not exist on this host`);
		else if (!same(bind.source, want)) drift.push(`its ${destination} is ${bind.source}, not ${want}`);
	}
	for (const m of state.mounts) {
		if (m.type === "bind" && Object.hasOwn(expected, m.destination)) continue;
		if (m.type === "volume" && IMAGE_VOLUMES.includes(m.destination)) continue;
		drift.push(`it has a ${m.type || "mount"} at ${m.destination} (from ${m.source || "nowhere named"}) that the shipped proxy does not`);
	}
	const unknown = unknownSources.length > 0 ? `${unknownSources.join(", ")} ${unknownSources.length === 1 ? "is a path" : "are paths"} this host cannot resolve (the runtime's own VM's, as Docker Desktop reports its sources), so ${unknownSources.length === 1 ? "that mount cannot" : "those mounts cannot"} be compared from here` : null;
	return { drift, unknown };
}

/** The job and sandbox networks attached to the proxy, which a removal would cut off (issue #453, gate round 2). */
export function jobNetworksOf(state) {
	return state.networks.filter((n) => n.startsWith("pi-job-") || n.startsWith("pi-sandbox-"));
}
