// Issue #730 (review round 1, L1): the one judge both OpenShell conformance scripts (copy and bind) use for the
// keyguard probe output, so the two lanes hold the claim with one copy of the rules and neither drifts
// into an equivalent mutant. Each takes the `key=value` lines the probe printed, parsed into an object, and returns
// { ok, detail }.

/**
 * The keyguard verdict. A tool child of the readable runner MUST reach an allowed host, and MUST be unable to read its
 * parent's memory. Strict, so a broken mitigation cannot pass:
 *   - `reach` is an HTTP status (the child reached the stand-in);
 *   - `addr` is a real readable region start, not "0" (else the memory probe tested nothing);
 *   - `mem` is denied at open() with EACCES or EPERM (Yama), never a READ and never another errno;
 *   - `syscalls` ran the compiled helper (a skipped build FAILS, it is not evidence) and both process_vm_readv and
 *     ptrace were refused with exactly "Operation not permitted" (the sandbox's seccomp), never a weaker errno.
 * The environ is NOT judged here (review round 2): a readable holder's environ IS readable by design, and what matters
 * is that no secret value is in it, which the copy pass's "the credentials" case already proves for every process in
 * the sandbox (`environ-values 0`), with the real provider and forge values.
 */
export function judgeKeyguard(said) {
	const reached = /^status \d/.test(said.reach ?? "");
	const addrOk = typeof said.addr === "string" && said.addr !== "" && said.addr !== "0";
	const memDenied = said.mem === "denied EACCES" || said.mem === "denied EPERM";
	const syscallsDenied = said.syscalls === "vmreadv=Operation not permitted ptrace=Operation not permitted";
	return { ok: reached && addrOk && memDenied && syscallsDenied, detail: JSON.stringify(said) };
}

/**
 * The coreguard verdict (review round 2, M1). A tool's SIGABRT of a readable key holder MUST leave no core it could
 * read. Strict, so a probe that did nothing cannot pass:
 *   - `shipped` is 1: the shipped entrypoint carries exactly the `ulimit -c 0` line, which the probe ran as written;
 *   - `kill` is ok and `signal` is SIGABRT: the holder really got the signal and died of it (a kill that failed, or a
 *     holder that lived, is a FAIL, never evidence);
 *   - `limit` is "0 0", read from the holder's own /proc/<pid>/limits (soft and hard), so nothing could raise it;
 *   - `cores` is none and `cwdfiles` 0: no core file in the holder's directory, /sandbox, /workspace or /tmp.
 * `pattern` (the host's core_pattern) is printed, not judged: under a pipe pattern the kernel hands a core to a
 * host-root handler outside the sandbox whatever the limit, so there the limit is what the case holds.
 */
export function judgeCoreguard(said) {
	const ok = said.shipped === "1" && said.kill === "ok" && said.signal === "SIGABRT" && said.limit === "0 0" && said.cores === "none" && said.cwdfiles === "0" && said.error === undefined;
	return { ok, detail: JSON.stringify(said) };
}

/** Parse `<prefix> key=value` lines from captured output into an object. */
export function probeFields(text, prefix) {
	const out = {};
	for (const m of String(text ?? "").matchAll(new RegExp(`^${prefix} ([a-z]+)=(.*)$`, "gm"))) out[m[1]] = m[2].trim();
	return out;
}
