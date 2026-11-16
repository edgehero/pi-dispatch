/**
 * The worker's grants for private endpoints (issue #918, DES-PRIVATE-ENDPOINT-GRANTS, INT-EGRESS-POLICY-CONTRACT).
 *
 * A grant is one file in this runtime's grant folder (`egress-grants/local/` for Docker, `egress-grants/podman/` for
 * rootless Podman, mounted read-only into that runtime's proxy at /etc/pi-dispatch/grants), named after an address the
 * proxy has on ONE job's network, holding a `network <name>` line and the ids of the private endpoints that job may
 * reach. squid's external ACL hands the shipped helper the address a request came in on (`%>la`) and an endpoint's
 * id; the helper answers OK only when the grant at that address names the id. So the proxy's rules never change per
 * job: the grant appears when the job's network is attached and goes before it is removed.
 *
 * THE GUARANTEE is the stale clear at attach (`clearStaleGrants`). Two live networks on one daemon never share a
 * subnet, so when the proxy joins a new network, every grant whose address falls in that network's subnets is left
 * over from a network that is gone (a worker that crashed, a proxy recreated under its networks, a network removed by
 * hand) and is deleted before anything runs on it. The removal at teardown (`removeGrantsOf`) and the boot sweep
 * (`sweepGrants`) are defence in depth, so a stale file does not wait for the next network on its subnet.
 *
 * Every grant is read back through the helper inside the proxy, as squid's own user, before the job starts
 * (`readBackArgs`): what is written is what squid will answer. Values here are addresses, network names and endpoint
 * ids, all the worker's own or the operator's, never a job's: nothing a job chooses reaches a path or a line.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { GRANT_HELPER_TARGET, GRANTS_DIR_NAME } from "./egress-proxy-state.mjs";

/** The default fs this module writes through; tests pass their own. */
export const GRANT_FS = Object.freeze({ chmodSync, closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync });

/** This runtime's grant folder in the deployment folder: `local` for the Docker CLI, `podman` for rootless Podman. */
export function grantsDirOf(cwd, bin) {
	return join(cwd, GRANTS_DIR_NAME, bin === "podman" ? "podman" : "local");
}

/** The inspect format that answers where the proxy sits on each of its networks, on Docker and Podman alike. */
export const PROXY_NETWORKS_FORMAT = "--format={{json .NetworkSettings.Networks}}";

/**
 * The proxy's addresses on `network`, from `PROXY_NETWORKS_FORMAT`'s output, as `{ address, prefix }` (IPv4 first,
 * then IPv6 when the network has one): what a grant is named after, and the subnet a stale grant is cleared from.
 * Empty when the output does not parse or names no address there.
 */
export function proxyAddressesOn(inspectOutput, network) {
	let networks;
	try {
		networks = JSON.parse(String(inspectOutput ?? "").trim());
	} catch {
		return [];
	}
	const on = networks?.[network];
	if (!on || typeof on !== "object") return [];
	const out = [];
	if (typeof on.IPAddress === "string" && isIPv4(on.IPAddress) && Number.isInteger(on.IPPrefixLen)) out.push({ address: on.IPAddress, prefix: on.IPPrefixLen });
	if (typeof on.GlobalIPv6Address === "string" && isIPv6(on.GlobalIPv6Address) && Number.isInteger(on.GlobalIPv6PrefixLen)) out.push({ address: canonicalIPv6(on.GlobalIPv6Address), prefix: on.GlobalIPv6PrefixLen });
	return out;
}

/** An IPv6 address as the compressed lowercase text squid's `%>la` prints it (`inet_ntop`), which a URL also writes. */
function canonicalIPv6(address) {
	try {
		return new URL(`http://[${address}]/`).hostname.slice(1, -1);
	} catch {
		return address.toLowerCase();
	}
}

/** An address as a BigInt, with its width in bits, or null. */
function addressBits(address) {
	if (isIPv4(address)) return { bits: address.split(".").reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n), width: 32 };
	if (!isIPv6(address)) return null;
	const [head, tail = ""] = address.toLowerCase().split("::");
	const left = head === "" ? [] : head.split(":");
	const right = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
	const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	return { bits: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n), width: 128 };
}

/** Whether `address` lies in the subnet of `base`/`prefix` (same family only). */
export function inSubnet(address, base, prefix) {
	const a = addressBits(address);
	const b = addressBits(base);
	if (!a || !b || a.width !== b.width || !Number.isInteger(prefix) || prefix < 0 || prefix > a.width) return false;
	const shift = BigInt(a.width - prefix);
	return a.bits >> shift === b.bits >> shift;
}

/**
 * Delete every grant in `dir` whose address lies in one of `on`'s subnets (`proxyAddressesOn`). Called right after the
 * proxy joins a new network and before anything runs on it: such a grant names an address this new network now owns,
 * so it is left over from a network that is gone. Returns the names removed. A folder that does not exist holds none
 * (a deployment from before #918). Any other failure to list or delete THROWS: the caller refuses to start a job on a
 * network that may carry another job's grant.
 */
export function clearStaleGrants({ dir, on, fs = GRANT_FS }) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
	const removed = [];
	for (const name of names) {
		if (!on.some(({ address, prefix }) => inSubnet(name, address, prefix))) continue;
		try {
			fs.unlinkSync(join(dir, name));
			removed.push(name);
		} catch (err) {
			if (err?.code !== "ENOENT") throw err;
		}
	}
	return removed;
}

/** A grant file's text: the network line, then one id per line, each line ending in a newline (the helper reads 16). */
export function grantText(network, ids) {
	return `network ${network}\n${ids.map((id) => `${id}\n`).join("")}`;
}

/**
 * Write one grant per address, each BY RENAME (a temp file beside it, made 0644 whatever the umask, synced, renamed),
 * so the helper never reads half a file and squid's own user can read it. Throws on any failure, after removing the
 * temp file; the caller then removes whatever this network's grants are and refuses to start the job.
 */
export function writeGrant({ dir, network, addresses, ids, fs = GRANT_FS }) {
	const text = grantText(network, ids);
	for (const { address } of addresses) {
		const path = join(dir, address);
		const tmp = join(dir, `.${address}.tmp-${process.pid}`);
		try {
			fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o644 });
			fs.chmodSync(tmp, 0o644);
			const fd = fs.openSync(tmp, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tmp, path);
		} catch (err) {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// a leftover temp file is named by its pid and its dot, and the helper reads no such name
			}
			throw err;
		}
	}
}

/**
 * Delete the grants that name `network`, by their own `network` line (a grant file is small, and the line is first).
 * Returns how many were removed. Throws once every entry was tried when one could not be read or deleted, for the caller
 * to say (`endpoint_grant_unremovable`); the network still goes, since the clear at the next attach in its subnet is
 * what keeps a job from inheriting what is left (`clearStaleGrants`).
 */
export function removeGrantsOf({ dir, network, fs = GRANT_FS }) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if (err?.code === "ENOENT") return 0;
		throw err;
	}
	let removed = 0;
	// Every entry is tried: one that cannot be read (a stray folder, another account's file) must not leave this
	// network's own grant behind. The first failure is thrown once all are tried, for the caller to say.
	let failure = null;
	for (const name of names) {
		if (name.startsWith(".")) continue;
		const path = join(dir, name);
		let first = null;
		try {
			first = String(fs.readFileSync(path, "utf8")).split("\n", 1)[0];
		} catch (err) {
			// Gone since the listing is no grant; one that cannot be read may be this network's, so it is said.
			if (err?.code !== "ENOENT") failure ??= err;
			continue;
		}
		if (first !== `network ${network}`) continue;
		try {
			fs.unlinkSync(path);
			removed += 1;
		} catch (err) {
			if (err?.code !== "ENOENT") failure ??= err;
		}
	}
	if (failure !== null) throw failure;
	return removed;
}

/**
 * The boot sweep: delete every grant whose `network` line names a network not in `live` (the job networks that still
 * exist), and every temp file left by a write that died. A grant that cannot be read is deleted too: nothing the
 * worker wrote is unreadable, so it is not one of this worker's live grants. Returns the names removed. Best effort per
 * file: the stale clear at attach is the guarantee.
 */
export function sweepGrants({ dir, live, fs = GRANT_FS }) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		// No folder holds no grant. Any other failure is thrown for the boot to say: a folder the worker cannot read fails
		// every job's attach, and the boot is where that is first visible.
		if (err?.code === "ENOENT") return [];
		throw err;
	}
	const removed = [];
	for (const name of names) {
		const path = join(dir, name);
		let keep = false;
		if (!name.startsWith(".")) {
			try {
				const first = String(fs.readFileSync(path, "utf8")).split("\n", 1)[0];
				keep = first.startsWith("network ") && live.has(first.slice("network ".length));
			} catch {
				keep = false;
			}
		}
		if (keep) continue;
		try {
			fs.unlinkSync(path);
			removed.push(name);
		} catch {
			// the next boot, or the next attach on its subnet, takes it
		}
	}
	return removed;
}

/** The read back's argv: the helper, run inside the proxy as squid's own user, with the lines on stdin. */
export function readBackArgs(proxy) {
	return ["exec", "-i", "--user", "proxy", proxy, GRANT_HELPER_TARGET];
}

/** The read back's stdin: one `<address> <id>` line per address and id, the line squid writes. */
export function readBackInput(addresses, ids) {
	return addresses.flatMap(({ address }) => ids.map((id) => `${address} ${id}\n`)).join("");
}

/** Whether the helper's answer is OK for every line asked. */
export function readBackPassed(stdout, count) {
	const lines = String(stdout ?? "").split("\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));
	return lines.length === count && lines.every((l) => l === "OK");
}

/** One bounded command with stdin, `{ code, stdout }`; `code` null when it could not run or ran out of time. */
export function runWithInput(spawnFn = nodeSpawn, bin, args, input, { timeoutMs = 15_000 } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			resolve({ code: null, stdout: "" });
			return;
		}
		let stdout = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, stdout });
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
			finish(null);
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (d) => {
			if (stdout.length < 64 * 1024) stdout += d;
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(typeof code === "number" ? code : null));
		// A child that exits without reading its stdin must not throw EPIPE out of this process: its exit code answers.
		child.stdin?.on?.("error", () => {});
		try {
			child.stdin?.end(input);
		} catch {
			finish(null);
		}
	});
}

/**
 * Everything the worker does when the proxy has just joined a job's network (`run-container.mjs`): clear what a gone
 * network left in this subnet, then, for a job granted private endpoints, write its grant and read it back through the
 * helper. Returns `{ ok: true, addresses }`, or `{ ok: false, why }` with a log-safe reason (no path, no id). Asks the
 * runtime nothing when the job holds no grant and the folder holds nothing to clear.
 */
export async function grantOnAttach({ spawnFn = nodeSpawn, bin, proxy, network, dir, ids, fs = GRANT_FS, run = runWithInput }) {
	let pending = true;
	if (ids.length === 0) {
		try {
			pending = fs.readdirSync(dir).length > 0;
		} catch (err) {
			if (err?.code === "ENOENT") return { ok: true, addresses: [] };
			return { ok: false, why: "grant-folder-unreadable" };
		}
		if (!pending) return { ok: true, addresses: [] };
	}
	const inspect = await run(spawnFn, bin, ["inspect", PROXY_NETWORKS_FORMAT, proxy], "");
	const addresses = inspect.code === 0 ? proxyAddressesOn(inspect.stdout, network) : [];
	if (addresses.length === 0) return { ok: false, why: "proxy-address-unread" };
	try {
		clearStaleGrants({ dir, on: addresses, fs });
	} catch {
		return { ok: false, why: "stale-grant-unremovable" };
	}
	if (ids.length === 0) return { ok: true, addresses };
	try {
		writeGrant({ dir, network, addresses, ids, fs });
	} catch {
		return { ok: false, why: "grant-unwritable" };
	}
	const answer = await run(spawnFn, bin, readBackArgs(proxy), readBackInput(addresses, ids));
	if (answer.code !== 0 || !readBackPassed(answer.stdout, addresses.length * ids.length)) return { ok: false, why: "grant-unreadable" };
	return { ok: true, addresses };
}
