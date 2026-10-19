/**
 * The openshell venue's facts that need no run path (issue #683): the tested release and the judgement of the gateway's
 * `status -o json`, shared by the adapter (worker/src/backend-openshell.mjs) and doctor (doctor-openshell.mjs). A leaf
 * with no imports, so doctor reads them without loading the run path and pi with it.
 */

/** The OpenShell release this adapter was measured on: doctor's floor and ceiling (issue #683), one place. */
export const OPENSHELL_TESTED_VERSION = "0.1.4";

/** Where that release is downloaded, for every line that tells an operator to install it (`up` installs nothing). */
export const OPENSHELL_RELEASE_URL = `https://github.com/NVIDIA/OpenShell/releases/tag/v${OPENSHELL_TESTED_VERSION}`;

/**
 * The macOS install that gives `brew services start openshell` something to start (review round 1 of #715): NVIDIA's
 * release asset `openshell.rb` carries the `service do` block; homebrew-core's `openshell` formula has none.
 */
export const OPENSHELL_BREW_INSTALL = `brew install https://github.com/NVIDIA/OpenShell/releases/download/v${OPENSHELL_TESTED_VERSION}/openshell.rb`;

/**
 * The local gateway as OpenShell 0.1.4 sets it up (issue #707): it listens on loopback at 17670, the deb ships it as the
 * systemd USER unit `openshell-gateway.service`, and the conformance lane registers it with `openshell gateway add
 * https://127.0.0.1:17670 --local --name openshell`. `up` offers that registration and `service install` orders the worker
 * after that unit, so the three are spelled once.
 */
export const OPENSHELL_LOCAL_GATEWAY_HOST = "127.0.0.1";
export const OPENSHELL_LOCAL_GATEWAY_PORT = 17670;
export const OPENSHELL_LOCAL_GATEWAY_URL = `https://${OPENSHELL_LOCAL_GATEWAY_HOST}:${OPENSHELL_LOCAL_GATEWAY_PORT}`;
export const OPENSHELL_GATEWAY_UNIT = "openshell-gateway.service";
export const OPENSHELL_DEFAULT_GATEWAY_NAME = "openshell";

/**
 * Why the openshell venues are refused on Windows (issue #707): the pinned release's assets (checked 2026-10-19 with
 * `gh api repos/NVIDIA/OpenShell/releases/tags/v0.1.4`) carry the CLI and the gateway for Linux (deb, rpm, snap, tarballs)
 * and macOS (aarch64 tarballs, a Homebrew formula) and nothing for Windows, so there is no gateway on this host to set up.
 */
export const OPENSHELL_NO_WINDOWS = `OpenShell ${OPENSHELL_TESTED_VERSION}, the release the openshell venue was measured on, ships no Windows build of its CLI or gateway (its release carries Linux and macOS ones only), so the openshell venue cannot run on this host. Run this deployment on Linux or macOS, or remove openshell from PI_BACKENDS`;

/**
 * The gateway's answer to "where are you" (`openshell status -o json`), judged: `{ connected, local, server, version }`.
 * `status` exits 0 even when the gateway is down (measured), so the JSON's own `status` decides `connected`. Local means
 * a loopback host or a unix socket; anything else, or a server this cannot parse, is not local.
 */
export function judgeGatewayStatus(doc) {
	const status = typeof doc?.status === "string" ? doc.status : null;
	const server = typeof doc?.server === "string" ? doc.server : null;
	let local = false;
	if (server !== null) {
		if (server.startsWith("unix:")) local = true;
		else {
			try {
				const host = new URL(server).hostname.replace(/^\[|\]$/g, "");
				local = host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
			} catch {
				local = false;
			}
		}
	}
	return { connected: status === "connected" || status === "connected_http", local, server, version: typeof doc?.version === "string" ? doc.version : null };
}

/**
 * BIND MODE (issue #686 part 3, the `openshell-bind` venue): what the gateway must be configured with before a sandbox
 * may carry the worker's binds, and how its refusals read. Here, in the leaf, because the adapter's preflight and doctor
 * judge the same answer and must not disagree about it.
 *
 * Measured on OpenShell 0.1.4, Docker driver, 2026-10-19: a create carrying `--driver-config-json` is refused, in this
 * ORDER, with the first sentence below on a default gateway, the second with only `allow_driver_config`, the third with
 * both but resource admission on; each in 50 to 90 ms, creating nothing. `gateway info -o json` does NOT reveal these
 * settings, so they can only be learned by asking a create (`bindProbeArgs`).
 */
export const OPENSHELL_BIND_SETTINGS = Object.freeze(["allow_driver_config", "enable_bind_mounts", "resource_admission"]);

/** Each setting's refusal, as upstream words it (unwrapped first: the CLI breaks its error box across lines). */
const BIND_REFUSAL_PATTERNS = Object.freeze([
	["allow_driver_config", /caller driver config is disabled|must enable allow_driver_config/],
	["enable_bind_mounts", /bind mounts require enable_bind_mounts = true/],
	["resource_admission", /cannot be attached while resource admission is enabled/],
]);

/** The one answer that proves the settings are on without anything being created: the probe's reserved target refused. */
const BIND_PROBE_ADMITTED = /mount target '\/sandbox' is reserved for the OpenShell workspace/;

/**
 * A create's failure text judged: `{ setting }` for one of the three bind-settings refusals, `{ admitted: true }` for the
 * probe's reserved-target refusal (the gateway read the binds, so its settings let them through), or `{}` for anything
 * else. Only fixed patterns are matched; nothing the CLI said is kept.
 */
export function judgeBindAnswer(text) {
	const said = String(text ?? "").replace(/[│\s]+/g, " ");
	for (const [setting, pattern] of BIND_REFUSAL_PATTERNS) if (pattern.test(said)) return { setting };
	if (BIND_PROBE_ADMITTED.test(said)) return { admitted: true };
	return {};
}

/** The engine's table, the three settings and the TOML header (measured: no `[openshell] version = 2`, no driver table). */
export function gatewayTomlFor(engine = "docker") {
	return ["[openshell]", "version = 2", "", `[openshell.drivers.${engine}]`, "allow_driver_config = true", "enable_bind_mounts = true", "", `[openshell.drivers.${engine}.resource_admission]`, "enabled = false", ""].join("\n");
}

/** Where the gateway reads it, in upstream's words, for a fix text. */
export const GATEWAY_TOML_WHERE = "the gateway's gateway.toml ($XDG_CONFIG_HOME/openshell/gateway.toml, or the file --config or OPENSHELL_GATEWAY_CONFIG names)";

/** Upstream's own warning (docs/how-it-works/sandboxes/runtimes.mdx at v0.1.4), quoted verbatim wherever bind mode is offered. */
export const UPSTREAM_BIND_WARNING = "Bind mounts expose gateway-host files to the sandbox and can bypass workspace isolation and filesystem policy.";

/** The `--driver-config-json` document for a list of `{ source, target, readOnly }`, keyed by the driver's name. */
export function driverConfigFor(engine, mounts) {
	return JSON.stringify({ [engine]: { mounts: mounts.map((m) => ({ type: "bind", source: m.source, target: m.target, read_only: m.readOnly === true, ...(m.selinuxLabel === "private" ? { selinux_label: "private" } : {}) })) } });
}

/**
 * The probe create (`judgeBindAnswer` reads its failure): one read-only bind of an empty directory onto `/sandbox`, a
 * target OpenShell reserves for the workspace. Measured: a gateway whose settings do not admit binds refuses it with the
 * setting's own sentence and creates nothing; one whose settings admit them gets past all three checks and fails it at
 * provisioning ("sandbox entered error phase while provisioning: ContainerCreateFailed: mount target '/sandbox' is
 * reserved for the OpenShell workspace"), LEAVING the sandbox in phase `Error`. So every caller deletes it on every
 * answer, and it is owner-labelled and named in the job namespace, so the boot reaper finds one a crash left.
 */
export function bindProbeArgs({ name, image, source, engine = "docker", ownerLabel, owner, modeLabel, gateway = null }) {
	return [...(typeof gateway === "string" && gateway !== "" ? ["--gateway", gateway] : []), "sandbox", "create", "--detach", "--name", name, "--from", image, "--label", `${ownerLabel}=${owner}`, "--label", `${modeLabel}=bind`, "--driver-config-json", driverConfigFor(engine, [{ source, target: "/sandbox", readOnly: true }]), "--no-auto-providers", "-o", "json"];
}
