/**
 * The egress allowlist as the proxy reads it, and whether a URL a job dials gets through (docs/egress.md). Squid
 * matches `egress-allowlist.conf` as a `dstdomain` file (deploy/egress-proxy.conf, `acl allowed dstdomain -n`): each
 * line, trimmed and with a `#` comment removed, is ONE entry, and an entry with a leading dot admits that domain and
 * every name under it. A line with two words is one entry that matches nothing (measured on the pinned squid: both
 * names refused), so it admits nothing here either. A job's runner sends every request as a CONNECT
 * (image/runner/src/env-proxy.mjs, `proxyTunnel: true`), and the proxy allows a CONNECT to an allowlisted name on port
 * 443 only, never to a host that resolves to this machine (`to_host_local`), and to a declared model endpoint on
 * exactly its host and port (`model-endpoints.conf`).
 *
 * The proxy stays the enforcement. This is the same reading done before anything is spent, so a job whose server the
 * policy cannot serve is refused with a reason instead of failing at its first call. It is a necessary condition, not
 * a sufficient one: a NAME that resolves to this machine is refused by the proxy and not here, since this reads no DNS.
 */
import { isIP } from "node:net";
import { basename } from "node:path";
import { isProxyLocalHost } from "./backends.mjs";
import { baseUrlTarget, endpointsAt } from "./model-endpoints.mjs";

/** The entries of an allowlist's text, lowercased, in order: one per line, a line with inner whitespace skipped. */
export function parseAllowlist(text) {
	const entries = [];
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		// A comment starts at a `#` that opens the line or follows whitespace; one inside a word is part of the word,
		// which then matches no host.
		const line = raw.replace(/(^|\s)#.*$/, "").trim();
		if (line === "" || /\s/.test(line)) continue;
		entries.push(line.toLowerCase());
	}
	return entries;
}

/** The first entry that admits `host`, or null: the name itself, or a leading-dot entry for it or a name above it. */
export function allowlistEntryFor(entries, host) {
	const name = String(host).toLowerCase();
	for (const entry of entries) {
		if (entry.startsWith(".") ? name === entry.slice(1) || name.endsWith(entry) : name === entry) return entry;
	}
	return null;
}

/** Whether `host` (as `baseUrlTarget` gives it) is an address squid's `to_host_local` refuses, or `localhost`. */
function hostIsLocal(host) {
	const bare = host.startsWith("[") ? host.slice(1, -1) : host;
	const kind = isIP(bare) === 4 ? "ipv4" : isIP(bare) === 6 ? "ipv6" : "name";
	if (isProxyLocalHost(kind, bare)) return true;
	if (kind === "ipv4") return bare.startsWith("169.254.");
	if (kind === "ipv6") return /^fe[89ab][0-9a-f]:/i.test(bare);
	return false;
}

/**
 * Why a job's CONNECT to `url` would be refused by the proxy, or null when it gets through: a declared endpoint's
 * exact host and port, or an allowlisted name on port 443, over https, that is not this machine. Both schemes go as
 * a CONNECT, so the proxy itself does not tell them apart.
 */
export function egressRefusalFor(url, { allowlist = [], endpoints = [] } = {}) {
	const target = baseUrlTarget(url);
	if (target === null) return "it is not an http or https URL";
	if (endpointsAt(url, endpoints).length > 0) return null;
	const entry = allowlistEntryFor(allowlist, target.host);
	if (entry !== null && hostIsLocal(target.host)) return `${target.host} is the proxy's own machine, which it never opens; a server on this machine is declared in model-endpoints.json under host.docker.internal or host.containers.internal`;
	// The proxy tunnels to 443 whatever speaks inside, so an `http://` url on 443 is plain HTTP to what is almost always
	// a TLS port, carrying the server's headers in clear inside the tunnel: refused, with the fix.
	if (entry !== null && target.port === 443 && new URL(url).protocol !== "https:") return `the egress proxy opens ${target.host} on port 443 for TLS, and this url is http://; use https://`;
	if (entry !== null && target.port === 443) return null;
	if (entry !== null) return `the egress proxy opens ${target.host} on port 443 only, and this is port ${target.port}; declare ${target.host}:${target.port} in model-endpoints.json to open exactly that port`;
	return `${target.host} is not in egress-allowlist.conf${target.port === 443 ? "" : ", and port " + target.port + " opens only as a declared endpoint in model-endpoints.json"}`;
}

/**
 * Every host a package runner fetches from at start, by name, since the proxy matches names: uv and pipx take the
 * index from pypi.org and the files from files.pythonhosted.org, yarn's default registry is its own name, and the npm
 * family reads registry.npmjs.org.
 */
export function packageRunnerHosts(command) {
	const runner = basename(String(command));
	if (["uv", "uvx", "pipx"].includes(runner)) return ["pypi.org", "files.pythonhosted.org"];
	if (runner === "yarn") return ["registry.yarnpkg.com"];
	return ["registry.npmjs.org"];
}
