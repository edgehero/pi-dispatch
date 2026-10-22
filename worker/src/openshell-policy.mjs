/**
 * The `openshell` venue's network policy, generated per job (issue #684, `CONST-VENUE-EGRESS-LAYER`'s second condition,
 * `INT-EGRESS-POLICY-CONTRACT`'s "A venue's own egress layer"). The SAME sources the squid venues read, translated into
 * OpenShell's `network_policies`, so the two venues admit the same hosts:
 *
 *   - `egress-allowlist.conf` (`parseAllowlist`): a name admits that host on 443; a leading `.x.y` admits `x.y` and every
 *     name under it, which OpenShell spells as the name plus a `*.x.y` wildcard. squid opens an allowlisted name on 443
 *     only (every request is a CONNECT, `deploy/egress-proxy.conf`), so 443 only here too.
 *   - `model-endpoints.json`: exactly each endpoint's host and port. A model server on the gateway host is reached by
 *     OpenShell's trusted aliases (`host.openshell.internal`, `host.docker.internal`, `host.containers.internal`,
 *     measured); a loopback name is never authorizable there, as `to_host_local` refuses it on squid.
 *   - GitHub's web host, when the allowlist admits it, carries the git transport and nothing else writable: reads,
 *     `git-upload-pack` and LFS batch requests for any repository, and `git-receive-pack` for the job's OWN repository
 *     only, so a push to any other repository is refused by the layer, which squid, matching names, never could. ONLY
 *     GitHub: there the API lives on its own host (api.github.com), so narrowing github.com costs the CLIs nothing. On
 *     GitLab, Forgejo and Azure the API shares the git host (and a self-hosted one may sit under a URL path), so the
 *     same narrowing would refuse every merge request and comment the job makes; their host keeps `access: full`, as
 *     squid gives it, and the push rule is GitHub's alone, said so in `INT-EGRESS-POLICY-CONTRACT`.
 *
 * Every endpoint says `enforcement: enforce`: OpenShell's default is `audit`, which reports a violation and lets it
 * through. Every endpoint says `protocol: rest`, so the layer reads each request (and can swap a credential placeholder
 * into it, issue #684 part 2); a WebSocket or another protocol on 443 that squid tunnelled blindly is refused here,
 * named in `INT-EGRESS-POLICY-CONTRACT`.
 *
 * THE BINARIES ARE NOT A CONTROL HERE, and saying so is the point. A rule's `binaries` match the connecting process or
 * ANY of its ancestors (OpenShell's own documentation), and every process of a job descends from
 * the runner's node (`/opt/pi-dispatch/runner-observable` on this venue since issue #730, `runner-node` before), which
 * must reach the provider. So each rule names the image's declared network
 * binaries (`dev.pi-dispatch.net-binaries`), the runner first, and that admits every tool the agent starts: the host
 * list is the boundary, exactly as it is on squid. The runner's node is put first whatever an image's label says,
 * since without it no provider call matches (an operator-built image's label may predate it).
 *
 * Pure: text in, a policy object out, and a refusal for what cannot be translated. Never reads a file.
 */
import { createHash } from "node:crypto";
import { allowlistEntryFor } from "./egress-allowlist.mjs";

/** The binary the runner and pi run as, which every job process descends from: always the first binary of every rule. */
export const RUNNER_NODE = "/opt/pi-dispatch/runner-node";
/**
 * Issue #730: the readable copy the job's key holders start from on the OpenShell venues (image/Dockerfile), so the
 * binary every provider call there leaves through. Listed beside RUNNER_NODE on every rule for the same reason that one
 * is: an image that predates the label still gets its runner named, and this venue refuses before spend an image that
 * lacks the copy (`observableRunner`).
 */
export const RUNNER_OBSERVABLE = "/opt/pi-dispatch/runner-observable";

/** A refusal this module returns instead of guessing: `{ refused, entry? }`. */
const refusal = (refused, extra = {}) => ({ refused, ...extra });

/** The DNS labels of a name. */
const labels = (name) => String(name).split(".").filter((l) => l !== "");

/** A hostname the policy may name: lowercase letters, digits, hyphens and dots, 253 at most. */
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The hosts one allowlist entry admits, as OpenShell names them, or a refusal. A leading-dot entry needs a wildcard of
 * at least three labels in OpenShell (`*.x.y`), so `.x.y` is fine and `.y` (a top-level domain) is refused by name: it
 * would admit a whole TLD on squid, and widening it here is not this file's to guess.
 */
export function hostsOfEntry(entry) {
	const e = String(entry).toLowerCase();
	if (e.startsWith(".")) {
		const base = e.slice(1);
		// A line squid reads as a name that matches nothing (a trailing dot, a port, an address) admits nothing here
		// either: skipped, never a refusal of every job, and named in the log by the caller.
		if (!HOST_RE.test(base)) return { hosts: [], skipped: e };
		if (labels(base).length < 2) return refusal("wildcard-too-wide", { entry: e });
		return { hosts: [base, `*.${base}`] };
	}
	if (!HOST_RE.test(e)) return { hosts: [], skipped: e };
	return { hosts: [e] };
}

/** The web host a job's forge serves git from, or null: GitHub's own, else the instance URL the deployment names. */
export function forgeGitHost(kind) {
	return kind === "github" ? "github.com" : null;
}

/**
 * The git-transport rules for the forge's web host: reads anywhere, a fetch from any repository, a push to `repo` only.
 * `repo` is the job's `owner/name` (GitHub, Forgejo) or its GitLab project path; a path segment outside the name rules
 * is refused rather than put into a glob, since a `*` or `**` in it would widen the push rule.
 */
export function forgeGitRules(repo) {
	// GitHub's own name rules: letters, digits, `_`, `.` and `-` (so `acme/.github` and `acme/_infra` are names), never
	// a segment of `.` or `..`, never a glob character, which would widen the push rule.
	if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((seg) => seg === "." || seg === "..")) return refusal("repo-not-a-path");
	const own = repo.replace(/\.git$/, "");
	return {
		rules: [
			{ allow: { method: "GET", path: "**" } },
			{ allow: { method: "HEAD", path: "**" } },
			{ allow: { method: "OPTIONS", path: "**" } },
			{ allow: { method: "POST", path: "/**/git-upload-pack" } },
			// Git LFS asks what to fetch with a POST; the objects themselves come from GitHub's media hosts.
			{ allow: { method: "POST", path: "/**/info/lfs/objects/batch" } },
			{ allow: { method: "POST", path: `/${own}.git/git-receive-pack` } },
			{ allow: { method: "POST", path: `/${own}/git-receive-pack` } },
		],
	};
}

/**
 * The rule key for a host and port: readable, and stable, with a short hash of the exact host so two hosts that
 * spell alike once sanitised (`a-b.com` and `a.b.com`, `*.x.y` and `any.x.y`) never overwrite each other's rule.
 */
function ruleKey(prefix, host, port) {
	const tag = createHash("sha256").update(`${host}:${port}`).digest("hex").slice(0, 8);
	return `${prefix}_${host.replace(/\*/g, "any").replace(/[^a-z0-9]+/g, "_").slice(0, 80)}_${port}_${tag}`;
}

/**
 * `networkPolicyFor({ allowlist, endpoints, kind, repo, binaries, onSkipped })` -> `{ network_policies }` or
 * `{ refused, entry? }`.
 *
 *   allowlist  the parsed `egress-allowlist.conf` entries (`parseAllowlist`)
 *   endpoints  the job's `model-endpoints.json` entries (`{ host, port }`)
 *   kind, repo the job's forge and repository, for GitHub's push rule
 *   binaries   the image's `dev.pi-dispatch.net-binaries` paths, after the runner's node, which is always first
 *   onSkipped  told of every allowlist line and label entry left out, for the log
 */
export function networkPolicyFor({ allowlist = [], endpoints = [], kind = null, repo = null, binaries = [], onSkipped = () => {} } = {}) {
	// The runner's node first, then the image's declared paths that are absolute and glob-free; an entry that is not is
	// skipped and named (a glob would widen the rule), never a refusal of every job for a label typo.
	const declared = (Array.isArray(binaries) ? binaries : []).map((b) => String(b).trim()).filter((b) => b !== "");
	for (const b of declared) if (!b.startsWith("/") || /[*?[\]{}]/.test(b)) onSkipped({ binary: b });
	const bins = [...new Set([RUNNER_NODE, RUNNER_OBSERVABLE, ...declared.filter((b) => b.startsWith("/") && !/[*?[\]{}]/.test(b))])].map((path) => ({ path }));
	const policies = {};
	const add = (key, endpoint) => {
		policies[key] = { name: key, endpoints: [{ ...endpoint, enforcement: "enforce" }], binaries: bins };
	};

	// The forge's web host, when the allowlist admits it: the git transport with the push rule, never `access: full`.
	const gitHost = kind ? forgeGitHost(kind) : null;
	let gitRules = null;
	if (gitHost !== null && allowlistEntryFor(allowlist, gitHost) !== null) {
		const r = forgeGitRules(repo);
		if (r.refused) return r;
		gitRules = r.rules;
		add(ruleKey("forge", gitHost, 443), { host: gitHost, port: 443, protocol: "rest", rules: gitRules });
	}

	for (const entry of allowlist) {
		const r = hostsOfEntry(entry);
		if (r.refused) return r;
		if (r.skipped) onSkipped({ entry: r.skipped });
		for (const host of r.hosts) {
			if (host === gitHost) continue; // its own rule above, narrower than `full`
			add(ruleKey("allow", host, 443), { host, port: 443, protocol: "rest", access: "full" });
		}
	}

	for (const ep of endpoints ?? []) {
		const host = String(ep?.host ?? "").toLowerCase();
		const port = Number(ep?.port);
		if (!HOST_RE.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) return refusal("endpoint-not-a-host-port", { entry: `${ep?.host}:${ep?.port}` });
		if (host === "localhost" || labels(host).length === 0) return refusal("endpoint-loopback", { entry: host });
		add(ruleKey("endpoint", host, port), { host, port, protocol: "rest", access: "full" });
	}
	return { network_policies: policies };
}
