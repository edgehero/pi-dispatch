#!/usr/bin/env node
/**
 * Issue #683: run the backend conformance harness against the REAL `openshell` bundle, on a host with an OpenShell
 * gateway (Docker driver) registered on loopback, and the job image in that gateway's engine.
 *
 * Every probe goes through the bundle `makeOpenshellBackend` builds, so what is checked is what a job gets:
 *
 *   - `probe`: the bundle's own `runContainer` (create, policy read-back, upload, `sandbox exec` through pi-landlock,
 *     download, delete) on an image built FROM the job image whose `/entrypoint.sh` exits with the integer in
 *     `/sandbox/job/prompt.md`, or sleeps for the abort, which is then stopped through the bundle's own `stopContainer`.
 *   - `withBrokenEnumeration`: the same bundle on a gateway name that is not registered, so the listing really fails.
 *   - `readBack`: one more run of that image whose entrypoint prints what the sandbox looks like from inside (its
 *     capabilities, seccomp, no_new_privs, pids and memory bounds, uid, mounts, network interfaces, an outbound
 *     connection attempt, a write into its job inputs), plus two of the bundle's own answers: the sandbox listed gone
 *     after the run, and a job image the engine does not hold refused before any sandbox exists.
 *
 * AND ONE CASE OF ITS OWN: the real job image's real runner, keyed, on the sandbox layout, offline under a cost cap of 0,
 * through the bundle, which must end on its own signed `cost-cap` line with the session brought back, and (issue #686)
 * whose session lines must reach the live transcript publisher as verified records over the exec's stderr. And (issue
 * #686, part 2) the same runner STEERED: two messages through the real relay down the exec's stdin as frames, the
 * second written mid-run, their acks back over the stderr transcript and their ids on the signed exit line, still at
 * zero spend (issue #725: on a zero-rated fake model the workflow's stand-in serves, so the run lives long enough).
 *
 * STRICTER THAN THE HARNESS, as podman-conformance.mjs is: any abstention among the read-back properties fails. Run it
 * with the worker STOPPED: the harness calls the real `reap`, which deletes every sandbox carrying this worker's owner
 * label, so this refuses to start while one exists.
 *
 *   PI_JOB_IMAGE=pi-job:ci node <repo>/.github/scripts/openshell-conformance.mjs
 *
 * Exit 0 when everything held, 1 when anything failed or was not read, 2 when the host is not one this can run on.
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { makeOpenshellBackend, OPENSHELL_OWNER, OPENSHELL_OWNER_LABEL, sandboxNameOf } = await load("worker/src/backend-openshell.mjs");
const { READ_BACK_BY_A_LIVE_PROBE, UNVERIFIED_BY_THIS_HARNESS, runBackendConformance } = await load("worker/src/backend-conformance.mjs");
const { buildRecord, makeLogSink } = await load("worker/src/run-history.mjs");
const { networkPolicyFor } = await load("worker/src/openshell-policy.mjs");
const { makeLiveTranscriptOpener } = await load("worker/src/live-transcript.mjs");
const { makeInboxRelay } = await load("worker/src/inbox-relay.mjs");
const { KEYLESS_API_KEY } = await load("worker/src/model-endpoints.mjs");

const refuse = (why) => {
	console.error(`openshell-conformance: ${why}`);
	process.exit(2);
};
const image = process.env.PI_JOB_IMAGE;
if (!image) refuse("PI_JOB_IMAGE must name the job image in the gateway's engine");
const engine = process.env.PI_OPENSHELL_ENGINE ?? "docker";
const nonce = randomBytes(4).toString("hex");
const scratch = nodeFs.mkdtempSync(join(tmpdir(), "pi-dispatch-openshell-conformance-"));
const run = (bin, args, timeout = 600_000) =>
	new Promise((resolveRun) => execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolveRun({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })));

const owned = await run("openshell", ["sandbox", "list", "--selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "-o", "json"]);
if (owned.code !== 0) refuse(`the gateway did not answer a listing: ${owned.stderr.trim().split("\n")[0]}`);
if (JSON.parse(owned.stdout).sandboxes?.length > 0) refuse("sandboxes with this worker's owner label exist; stop the worker and delete them first");

// The probe image: the job image with its entrypoint replaced, so an exit code is the integer the harness asked for.
const context = join(scratch, "probe");
nodeFs.mkdirSync(context);
nodeFs.writeFileSync(
	join(context, "entrypoint.sh"),
	`#!/bin/sh
c=$(cat /sandbox/job/prompt.md 2>/dev/null || cat /job/prompt.md)
case "$c" in
	sleep) exec sleep 600 ;;
	readback)
		echo "probe uid=$(id -u)"
		grep -E '^(CapEff|NoNewPrivs|Seccomp):' /proc/self/status | tr -d '\\t' | sed 's/^/probe /'
		echo "probe pids.max=$(cat /sys/fs/cgroup/pids.max 2>&1)"
		echo "probe memory.max=$(cat /sys/fs/cgroup/memory.max 2>&1)"
		echo "probe sandbox-mounts=$(awk '$5 ~ /^\\/sandbox/ {print $5}' /proc/self/mountinfo | tr '\\n' ' ')"
		echo "probe ifaces=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' ')"
		echo "probe egress=$(node -e 'const s=require("net").connect({host:"1.1.1.1",port:443,timeout:5000});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("timeout",()=>{console.log("blocked");process.exit(0)});s.on("error",()=>{console.log("blocked");process.exit(0)})')"
		if echo planted >> /sandbox/job/prompt.md 2>/dev/null; then echo "probe jobwrite=allowed"; else echo "probe jobwrite=denied"; fi
		# Issue #684: the generated policy, read from inside. An allowlisted host answers (any HTTP status), an unlisted
		# one does not, and a model server on the gateway host answers under each alias the policy names.
		for u in https://api.anthropic.com/ https://example.com/ http://host.openshell.internal:18080/ http://host.docker.internal:18080/ https://github.com/ https://api.github.com/; do
			echo "probe url $u=$(node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(10000)}).then(r=>console.log("reached",r.status),e=>console.log("refused",e.cause?.code??e.name))' "$u")"
		done
		# Issue #684 part 2: the job's credentials are placeholders in the agent, no process's environment holds a value,
		# and the supervisor swaps the real one in for a request to an admitted host: a header to the stand-in, and git's
		# Basic auth through the worker-set credential helper (the stand-in records both, the script reads its log).
		echo "probe envkey=$(case "$ANTHROPIC_API_KEY" in openshell:resolve:env:*) echo placeholder ;; conformance-probe-not-a-key) echo value ;; '') echo unset ;; *) echo other ;; esac)"
		echo "probe envtoken=$(case "$GH_TOKEN" in openshell:resolve:env:*) echo placeholder ;; conformance-probe-not-a-token) echo value ;; '') echo unset ;; *) echo other ;; esac)"
		# Readable means NON-EMPTY: under OpenShell 0.1.4 the file opens and reads as nothing (measured, self and parent).
		echo "probe environ-readable=$(if [ "$(tr '\\0' '\\n' < /proc/self/environ 2>/dev/null | wc -c)" -gt 0 ]; then echo yes; else echo no; fi)"
		echo "probe environ-self=$(tr '\\0' '\\n' < /proc/self/environ | grep -c -e '^ANTHROPIC_API_KEY=openshell:resolve:env:')"
		echo "probe environ-values=$(cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c -e conformance-probe-not-a)"
		echo "probe header=$(node -e 'fetch("http://host.openshell.internal:18080/header",{headers:{"x-api-key":process.env.ANTHROPIC_API_KEY},signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log("refused",e.cause?.code??e.name))')"
		echo "probe git=$(cd /tmp && GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote http://host.openshell.internal:18080/edgehero/pi-dispatch-conformance.git >/dev/null 2>&1; echo $?)"
		# The forge rule: a push to another repository than the job's is refused by the LAYER (its own 403 body names
		# the policy), never answered by GitHub, which would say 401.
		for u in https://github.com/octocat/Hello-World.git/git-receive-pack; do
			echo "probe push $u=$(node -e 'fetch(process.argv[1],{method:"POST",signal:AbortSignal.timeout(10000)}).then(async r=>console.log(r.status,/policy/i.test(await r.text())?"policy":"upstream"),e=>console.log("refused",e.cause?.code??e.name))' "$u")"
		done
		exit 0 ;;
	bundle)
		# Issue #704 part 3: a project secret bundle. BUNDLE_TOKEN is bound to host.docker.internal (its own provider) and
		# is a placeholder here and in /proc/self/environ; BUNDLE_PLAIN is a value. The placeholder is swapped at its own
		# host only: sent to the other alias (the job provider's endpoint) it is refused, and the job's own model key sent
		# to the bundle's host is refused too, since an endpoint binds one provider.
		echo "probe btoken=$(case "$BUNDLE_TOKEN" in openshell:resolve:env:*) echo placeholder ;; conformance-bundle-not-a-token) echo value ;; '') echo unset ;; *) echo other ;; esac)"
		# Review round 1, H1: the plain one reaches the runner by FILE (this probe replaces the runner, so it reads the file
		# itself; verify-image.sh proves the runner applies it), never the exec: no process's command line holds it.
		echo "probe bplain=$(if [ "$PI_BUNDLE_ENV" = 1 ] && grep -q conformance-bundle-plain-value /sandbox/job/bundle-env.json 2>/dev/null; then echo file; elif [ -n "$BUNDLE_PLAIN" ]; then echo env; else echo other; fi)"
		echo "probe bcmdline=$(cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -c -e 'conformance-bundle-plain-valu[e]')"
		# Readable means NON-EMPTY, read the way the count below reads it (a redirect, so the subshell's own environ, not a
		# fresh child's): under OpenShell 0.1.4 that file opens and reads as nothing, as the credentials case measured.
		echo "probe benviron-readable=$(if [ "$(tr '\\0' '\\n' < /proc/self/environ 2>/dev/null | wc -c)" -gt 0 ]; then echo yes; else echo no; fi)"
		echo "probe benviron=$(tr '\\0' '\\n' < /proc/self/environ | grep -c -e '^BUNDLE_TOKEN=openshell:resolve:env:')"
		echo "probe benviron-values=$(cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c -e conformance-bundle-not-a-token)"
		echo "probe bown=$(node -e 'fetch("http://host.docker.internal:18080/bundle-own",{headers:{authorization:"Bearer "+process.env.BUNDLE_TOKEN},signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log("refused",e.cause?.code??e.name))')"
		echo "probe bother=$(node -e 'fetch("http://host.openshell.internal:18080/bundle-elsewhere",{headers:{authorization:"Bearer "+process.env.BUNDLE_TOKEN},signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log("refused",e.cause?.code??e.name))')"
		echo "probe bkey=$(node -e 'fetch("http://host.docker.internal:18080/key-at-bundle-host",{headers:{"x-api-key":process.env.ANTHROPIC_API_KEY},signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log("refused",e.cause?.code??e.name))')"
		exit 0 ;;
	netpath)
		# Issue #725 diagnostics: the routes a model call can take from this sandbox to the stand-in, each printed and
		# none asserted. The policy probes above fetch with the image's plain node and a GET; a job's provider call is a
		# streamed POST from the runner's own binary, after pi has replaced the fetch dispatcher (docs/egress.md, issue
		# #427), through the OpenAI SDK. Each step below changes one of those, so the first one to fail names the cause.
		# Under /opt: the sandbox policy reads only its listed paths (sandboxPolicy's read_only), so a file at / is unreadable
		# and the first run printed nothing. Each binary's exit and the head of its stderr are printed, so a load failure
		# is a line too.
		node /opt/pi-dispatch-probe/netpath.mjs node 2>/tmp/netpath.err; echo "probe netpath node exit=$?"
		head -c 2000 /tmp/netpath.err | head -n 8 | sed 's/^/probe netpath node stderr=/'
		/opt/pi-dispatch/runner-node /opt/pi-dispatch-probe/netpath.mjs runner 2>/tmp/netpath.err; echo "probe netpath runner exit=$?"
		head -c 2000 /tmp/netpath.err | head -n 8 | sed 's/^/probe netpath runner stderr=/'
		exit 0 ;;
	netpath-obs)
		# Issue #730 E2: the same steps under the fresh 0755 copy at a policy-listed path of its own.
		/opt/pi-dispatch/runner-observable /opt/pi-dispatch-probe/netpath.mjs runner 2>/tmp/netpath.err; echo "probe netpath observable exit=$?"
		head -c 2000 /tmp/netpath.err | head -n 8 | sed 's/^/probe netpath observable stderr=/'
		exit 0 ;;
	inv-e1)
		# Issue #730 E1: the mechanism's inputs, from inside the sandbox. A nondumpable process's /proc is root-owned and
		# ptrace-gated, which is what the broker's same-uid memory read hits.
		# Dumpable is not a /proc/<pid>/status field. The kernel shows it another way: a nondumpable process's /proc
		# entries are root-owned and a same-uid sibling cannot open its environ.
		for b in /usr/local/bin/node /opt/pi-dispatch/runner-node; do
			"$b" -e 'setTimeout(()=>{},5000)' & p=$!; sleep 1
			echo "probe e1 dumpable $b=proc-owner $(stat -c %U /proc/$p) environ $(head -c1 /proc/$p/environ >/dev/null 2>&1 && echo readable || echo denied)"
			kill $p 2>/dev/null; wait $p 2>/dev/null
		done
		echo "probe e1 runner-node-stat=$(stat -c '%a %U:%G' /opt/pi-dispatch/runner-node)"
		echo "probe e1 node-stat=$(stat -c '%a %U:%G' /usr/local/bin/node)"
		echo "probe e1 ptrace-scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>&1)"
		echo "probe e1 whoami=$(id -u):$(id -g)"
		exit 0 ;;
	inv-child-node|inv-child-runner)
		# Issue #730 E3/E4: a parent holding a canary in memory (a buffer), in its environment and on fd 0 spawns a tool
		# child (always the dumpable node, as pi's bash tool would). The child tries to reach the network (E3) and to read
		# the parent's secrets by each route (E4). The parent is the dumpable node or the nondumpable runner, so the pair
		# of runs shows what an ancestor's dumpability changes.
		MEMCANARY_FILE=/tmp/memcanary; printf 'CANARY-MEM-9z7y' > "$MEMCANARY_FILE"
		export ENVCANARY=CANARY-ENV-9z7y
		case "$c" in inv-child-node) RUNNER=/usr/local/bin/node ;; *) RUNNER=/opt/pi-dispatch/runner-node ;; esac
		echo "probe e34 parent=$c runner=$RUNNER"
		"$RUNNER" /opt/pi-dispatch-probe/parent.mjs "$MEMCANARY_FILE" < "$MEMCANARY_FILE" 2>&1 | sed 's/^/probe /'
		echo "probe e34 parent-exit=$?"
		exit 0 ;;
	*) exit "$c" ;;
esac
`,
	{ mode: 0o755 },
);
// Issue #725 diagnostics, run by the `netpath` mode: one line per route, `probe netpath <binary> <step>=<answer>`. The
// POST carries a `tool` message, so the stand-in answers it at once ("done") rather than holding it for the steering
// case's signal. Errors are printed by name and cause code (and a short cause message), never a body.
nodeFs.writeFileSync(
	join(context, "netpath.mjs"),
	`const who = process.argv[2];
const base = "http://host.openshell.internal:18080";
const body = JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "x" }] });
const why = (e) => { const c = e?.cause; return [e?.name, e?.constructor?.name, c?.code ?? c?.cause?.code ?? "", String(c?.message ?? e?.message ?? "").slice(0, 160)].join(" "); };
const step = async (label, fn) => { try { console.log("probe netpath " + who + " " + label + "=" + (await fn())); } catch (e) { console.log("probe netpath " + who + " " + label + "=error " + why(e)); } };
const get = async () => { const r = await fetch(base + "/", { signal: AbortSignal.timeout(10000) }); return "status " + r.status; };
const post = (auth) => async () => { const r = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer keyless" } : {}) }, body, signal: AbortSignal.timeout(15000) }); const t = await r.text(); return "status " + r.status + " " + (r.headers.get("content-type") ?? "") + " " + (t.includes("[DONE]") ? "complete" : "partial") + " " + t.length; };
await step("get", get);
await step("post-sse-noauth", post(false));
await step("post-sse", post(true));
if (who === "runner") {
	await step("load-pi", async () => { const m = await import("/app/image/runner/src/env-proxy.mjs"); return "env proxy restored " + (await m.loadPiThenRestore()); });
	await step("pi-get", get);
	await step("pi-post-sse", post(true));
	await step("pi-openai-sdk", async () => {
		const { createRequire } = await import("node:module");
		const { pathToFileURL } = await import("node:url");
		const at = createRequire("/app/node_modules/@earendil-works/pi-ai/package.json").resolve("openai");
		const OpenAI = (await import(pathToFileURL(at).href)).default;
		const client = new OpenAI({ apiKey: "keyless", baseURL: base + "/v1", maxRetries: 0, timeout: 15000 });
		const stream = await client.chat.completions.create({ ...JSON.parse(body) });
		let n = 0;
		for await (const _ of stream) n += 1;
		return "chunks " + n;
	});
}
`,
);

// Issue #730 E3/E4 harness. The parent keeps a canary in a buffer, in its environ and on fd 0, prints one readable
// address from its own maps, then spawns the tool child (the dumpable node). Never a real secret: a synthetic marker.
nodeFs.writeFileSync(
	join(context, "parent.mjs"),
	`import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const canaryFile = process.argv[2];
const mem = Buffer.from(readFileSync(canaryFile)); // the canary, held in this process's memory
try { unlinkSync(canaryFile); } catch {}
globalThis.__hold = mem; // keep it live for the child's read attempts
let addr = "0";
try {
	for (const line of readFileSync("/proc/self/maps", "utf8").split("\\n")) {
		const m = /^([0-9a-f]+)-[0-9a-f]+ r/.exec(line);
		if (m) { addr = m[1]; break; }
	}
} catch {}
writeFileSync("/tmp/paddr", addr);
const child = spawnSync("/usr/local/bin/node", ["/opt/pi-dispatch-probe/child.mjs", String(process.pid), addr], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(child.status ?? 1);
`,
);
nodeFs.writeFileSync(
	join(context, "child.mjs"),
	`import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [ppid, addr] = process.argv.slice(2);
const base = "http://host.openshell.internal:18080";
const line = (k, v) => console.log("e4 " + k + "=" + v);
// E3: can a tool child reach the network at all (its ancestor includes the runner)?
try { const r = await fetch(base + "/", { signal: AbortSignal.timeout(10000) }); line("e3-fetch", "status " + r.status); }
catch (e) { line("e3-fetch", "error " + (e?.name ?? "") + " " + (e?.cause?.code ?? e?.message ?? "")); }
const git = spawnSync("git", ["ls-remote", "https://github.com/octocat/Hello-World"], { timeout: 30000, encoding: "utf8" });
line("e3-git", "code " + git.status + " " + String(git.stderr ?? "").split("\\n")[0].slice(0, 80));
// E4: read the parent's secrets by each file route. errno (the .code) is the signal.
try { const env = readFileSync("/proc/" + ppid + "/environ", "utf8"); line("e4-environ", env.includes("CANARY-ENV-9z7y") ? "READ canary" : "read no-canary " + env.length); }
catch (e) { line("e4-environ", "error " + e.code); }
try { const fd = openSync("/proc/" + ppid + "/mem", "r"); const b = Buffer.alloc(64); const n = readSync(fd, b, 0, 64, parseInt(addr, 16)); closeSync(fd); line("e4-mem", "READ " + n + " bytes " + (b.includes(Buffer.from("CANARY-MEM-9z7y")) ? "(canary)" : "")); }
catch (e) { line("e4-mem", "error " + e.code); }
try { const fd = openSync("/proc/" + ppid + "/fd/0", "r"); const b = Buffer.alloc(64); const n = readSync(fd, b, 0, 64, 0); closeSync(fd); line("e4-fd0", "READ " + n + " bytes " + (b.includes(Buffer.from("CANARY-MEM-9z7y")) ? "(canary)" : "")); }
catch (e) { line("e4-fd0", "error " + e.code); }
// process_vm_readv and ptrace: a compiled helper if the image build could add one, else noted (the sandbox's child
// seccomp denies both syscalls per OpenShell source, child_seccomp.rs; this measures it).
const helper = spawnSync("/opt/pi-dispatch-probe/memtry", [ppid, addr], { encoding: "utf8" });
line("e4-syscalls", helper.error ? "helper-absent " + helper.error.code : String(helper.stdout ?? "").trim().replace(/\\n/g, " | "));
`,
);
// A tiny C helper for the two syscall routes, compiled at image build (gcc added just for it). Best effort: if the
// build cannot add gcc the helper is absent and the child says so.
nodeFs.writeFileSync(
	join(context, "memtry.c"),
	`#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/uio.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
int main(int argc, char **argv) {
	pid_t pid = atoi(argv[1]);
	unsigned long addr = argc > 2 ? strtoul(argv[2], 0, 16) : 0;
	char buf[32] = {0};
	struct iovec local = { buf, sizeof buf };
	struct iovec remote = { (void *)addr, sizeof buf };
	ssize_t n = process_vm_readv(pid, &local, 1, &remote, 1, 0);
	printf("process_vm_readv=%s", n < 0 ? strerror(errno) : "ok");
	long r = ptrace(PTRACE_ATTACH, pid, 0, 0);
	printf(" ptrace_attach=%s", r < 0 ? strerror(errno) : "ok");
	if (r == 0) { waitpid(pid, 0, 0); ptrace(PTRACE_DETACH, pid, 0, 0); }
	printf("\\n");
	return 0;
}
`,
);
nodeFs.writeFileSync(join(context, "Dockerfile"), `FROM ${image}\nUSER root\nCOPY entrypoint.sh /entrypoint.sh\nCOPY netpath.mjs parent.mjs child.mjs /opt/pi-dispatch-probe/\nCOPY memtry.c /opt/pi-dispatch-probe/memtry.c\nRUN (apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && cc -O2 -o /opt/pi-dispatch-probe/memtry /opt/pi-dispatch-probe/memtry.c) || echo "memtry build skipped"\nRUN chmod 0755 /entrypoint.sh && chmod 0755 /opt/pi-dispatch-probe && chmod 0644 /opt/pi-dispatch-probe/netpath.mjs /opt/pi-dispatch-probe/parent.mjs /opt/pi-dispatch-probe/child.mjs\nUSER pi\n`);
const probeImage = `pi-dispatch-openshell-probe:${nonce}`;
const built = await run(engine, ["build", "--pull=false", "-q", "-t", probeImage, context]);
if (built.code !== 0) refuse(`the probe image did not build: ${built.stderr.trim().split("\n").slice(-1)[0]}`);

// Issue #730 investigation variants, built from the same context with an extra Dockerfile each. The default probe
// image keeps runner-node at the shipped 0711 (nondumpable). These do not, so the lane can measure what dumpability
// alone changes, with the same bytes at the same path (so OpenShell's TOFU binary hash is unchanged):
//   - probeImage0755: runner-node chmod 0755 (readable, so exec leaves it dumpable).
//   - probeImageNewPath: a 0755 copy of node at /opt/pi-dispatch/runner-observable, added to the net-binaries label
//     so the generated policy lists it (a never-shipped path, to see whether a fresh listed path works at all).
const probeImage0755 = `pi-dispatch-openshell-probe-0755:${nonce}`;
nodeFs.writeFileSync(join(context, "Dockerfile.0755"), `FROM ${probeImage}\nUSER root\nRUN chmod 0755 /opt/pi-dispatch/runner-node\nUSER pi\n`);
const built0755 = await run(engine, ["build", "--pull=false", "-q", "-t", probeImage0755, "-f", join(context, "Dockerfile.0755"), context]);
if (built0755.code !== 0) console.log(`diag    the 0755-runner variant did not build: ${built0755.stderr.trim().split("\n").slice(-1)[0]}`);
const probeImageNewPath = `pi-dispatch-openshell-probe-newpath:${nonce}`;
const NET_LABEL = "dev.pi-dispatch.net-binaries";
const baseBinaries = (await run(engine, ["image", "inspect", "--format", `{{index .Config.Labels "${NET_LABEL}"}}`, probeImage])).stdout.trim();
nodeFs.writeFileSync(join(context, "Dockerfile.newpath"), `FROM ${probeImage}\nUSER root\nRUN install -o root -g root -m 0755 /usr/local/bin/node /opt/pi-dispatch/runner-observable\nLABEL ${NET_LABEL}="${baseBinaries},/opt/pi-dispatch/runner-observable"\nUSER pi\n`);
const builtNewPath = await run(engine, ["build", "--pull=false", "-q", "-t", probeImageNewPath, "-f", join(context, "Dockerfile.newpath"), context]);
if (builtNewPath.code !== 0) console.log(`diag    the new-path variant did not build: ${builtNewPath.stderr.trim().split("\n").slice(-1)[0]}`);

const output = new Map();
const bundleFor = (img, extra = {}) =>
	makeOpenshellBackend({
		image: img,
		engine,
		hostEnv: { ANTHROPIC_API_KEY: "conformance-probe-not-a-key" },
		onOutput: (chunk) => output.set("last", (output.get("last") ?? "") + String(chunk)),
		...extra,
	});
// Issue #684: the policy every probe runs under: the provider's host, and a model server on the gateway host (the
// workflow starts one on 18080) under both aliases. example.com is deliberately absent.
const POLICY_SOURCES = { readAllowlist: () => ["api.anthropic.com", ".github.com"], readEndpoints: () => [{ id: "lab-a", host: "host.openshell.internal", port: 18080, slots: 1 }, { id: "lab-b", host: "host.docker.internal", port: 18080, slots: 1 }] };
const backend = bundleFor(probeImage, POLICY_SOURCES);
let n = 0;
const jobDirFor = (prompt) => {
	const jobDir = join(scratch, `job-${++n}`);
	nodeFs.mkdirSync(join(jobDir, "workspace"), { recursive: true });
	nodeFs.mkdirSync(join(jobDir, "session"), { recursive: true });
	nodeFs.writeFileSync(join(jobDir, "prompt.md"), `${prompt}\n`);
	nodeFs.writeFileSync(join(jobDir, "session", "current.jsonl"), "");
	return { jobDir, workspace: join(jobDir, "workspace"), live: { hostDir: join(jobDir, "session") } };
};
const JOB = { id: "conformance", kind: "github", repo: "edgehero/pi-dispatch-conformance", provider: "anthropic", model: "claude-sonnet-4-5-20250929", maxTurns: 1 };

async function probe(b, { exitCode, aborted = false }) {
	const ac = new AbortController();
	const name = `pi-job-conformance-${nonce}-${n + 1}`;
	const dirs = jobDirFor(aborted ? "sleep" : String(exitCode));
	const running = b.runContainer({ job: JOB, prepared: dirs, name, signal: ac.signal, size: { memMiB: 1024, cpuCenti: 100 } });
	if (aborted) {
		// The stop index.mjs sends on a timeout: the abort flag first, then the venue's own stop, once the exec runs.
		for (let i = 0; i < 120; i++) {
			const listed = await run("openshell", ["sandbox", "get", name, "-o", "json"], 15_000);
			if (listed.code === 0 && JSON.parse(listed.stdout).phase === "Ready") break;
			await new Promise((r) => setTimeout(r, 1000));
		}
		await new Promise((r) => setTimeout(r, 5000));
		ac.abort();
		await b.stopContainer(name);
	}
	return running;
}

const withBrokenEnumeration = () => bundleFor(probeImage, { gateway: `no-such-gateway-${nonce}` }).reap();

async function readBack(b) {
	output.set("last", "");
	const name = `pi-job-conformance-${nonce}-readback`;
	const result = await b.runContainer({ job: JOB, token: "conformance-probe-not-a-token", prepared: jobDirFor("readback"), name, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const said = Object.fromEntries([...String(output.get("last")).matchAll(/^probe ([A-Za-z.-]+)[=:][ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	const urls = Object.fromEntries([...String(output.get("last")).matchAll(/^probe url (\S+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	const pushes = Object.fromEntries([...String(output.get("last")).matchAll(/^probe push (\S+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	Object.assign(readings, { urls, pushes, said });
	const gone = await b.containerGone(name);
	let pinned;
	try {
		await bundleFor(`pi-dispatch-not-in-this-engine:${nonce}`).runContainer({ job: JOB, prepared: jobDirFor("0"), name: `pi-job-conformance-${nonce}-absent`, signal: new AbortController().signal });
		pinned = { ok: false, detail: "a job image the engine does not hold ran" };
	} catch (err) {
		const listed = await run("openshell", ["sandbox", "get", `pi-job-conformance-${nonce}-absent`, "-o", "json"], 15_000);
		pinned = err?.reason === "container-never-started" && listed.code !== 0 ? { ok: true, detail: "an image the engine does not hold is refused before any sandbox exists (the ID is read from the engine, never pulled)" } : { ok: false, detail: `refused as ${err?.reason ?? err?.message}, sandbox listed: ${listed.code === 0}` };
	}
	console.log(`readback (exit ${result.code}): ${JSON.stringify(said)}`);
	const ifaces = (said.ifaces ?? "").split(" ").filter(Boolean);
	return {
		isolation: { ok: said.CapEff === "0000000000000000" && said.NoNewPrivs === "1" && said.Seccomp === "2" && /^\d+$/.test(said["pids.max"] ?? "") && said["memory.max"] === String(1024 * 1024 * 1024), detail: `CapEff ${said.CapEff}, NoNewPrivs ${said.NoNewPrivs}, Seccomp ${said.Seccomp}, pids.max ${said["pids.max"]}, memory.max ${said["memory.max"]}` },
		ephemeral: { ok: gone === true, detail: `the bundle's own gone-check after the run said ${gone}` },
		mountSet: { ok: (said["sandbox-mounts"] ?? "") === "", detail: `mounts under /sandbox: ${JSON.stringify(said["sandbox-mounts"] ?? null)} (a copy mounts nothing there)` },
		egress: { ok: said.egress === "blocked", detail: `an outbound connection to 1.1.1.1:443 was ${said.egress ?? "not tried"}` },
		jobToJobIsolation: { ok: ifaces.length > 0 && ifaces.every((i) => i === "lo"), detail: `network interfaces: ${ifaces.join(", ") || "none read"}` },
		imagePinning: pinned,
		nonRoot: { ok: /^[1-9]\d*$/.test(said.uid ?? ""), detail: `uid ${said.uid}` },
		localFolders: { ok: false, detail: "copy mode edits a copy, never a folder in place (declared absent)" },
		readOnlyJobInputs: { ok: said.jobwrite === "denied", detail: `an append to /sandbox/job/prompt.md was ${said.jobwrite ?? "not tried"}` },
	};
}

let failed = false;
const readings = {};
const r = await runBackendConformance(backend, { probe, withBrokenEnumeration, readBack: async (b) => Object.assign(readings, await readBack(b)) });
for (const f of r.findings) {
	console.log(`${f.ok ? (f.unverifiable ? "ABSTAIN" : "ok     ") : "FAIL   "} ${f.property ?? f.check}: ${f.detail ?? ""}`);
	if (!f.ok) failed = true;
	if (f.unverifiable && READ_BACK_BY_A_LIVE_PROBE.includes(f.property ?? f.check)) failed = true;
}
// Issue #684: the generated policy, held to what it says: the allowlisted host and both model-server aliases reached, the
// unlisted host refused.
{
	const u = readings.urls ?? {};
	const reached = (url) => /^reached /.test(u[url] ?? "");
	const push = readings.pushes?.["https://github.com/octocat/Hello-World.git/git-receive-pack"] ?? "";
	const ok = reached("https://api.anthropic.com/") && !reached("https://example.com/") && reached("http://host.openshell.internal:18080/") && reached("http://host.docker.internal:18080/") && reached("https://github.com/") && reached("https://api.github.com/") && /^403 policy$/.test(push);
	console.log(`${ok ? "ok     " : "FAIL   "} the generated policy: ${JSON.stringify({ ...u, push })}`);
	if (!ok) failed = true;
}
// Issue #684 part 2: the credentials. Placeholders in the agent, no value in any environment it can read, and the real
// values received by the stand-in only after the supervisor's swap (a header, and git's Basic auth via the helper).
{
	const said = readings.said ?? {};
	let seen = [];
	try {
		seen = nodeFs.readFileSync(process.env.STANDIN_LOG ?? "", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {}
	const basic = `Basic ${Buffer.from("x-access-token:conformance-probe-not-a-token").toString("base64")}`;
	const swapped = seen.some((e) => e.xApiKey === "conformance-probe-not-a-key");
	// A placeholder that reached the stand-in unswapped, in a header or inside git's base64 Basic credentials.
	const decoded = (a) => (/^Basic /.test(a ?? "") ? Buffer.from(a.slice(6), "base64").toString("utf8") : (a ?? ""));
	const leaked = seen.some((e) => /openshell:resolve/.test(`${e.xApiKey ?? ""}${decoded(e.authorization)}`));
	const git = seen.some((e) => e.authorization === basic);
	// The values in no readable environment: either the process's own environ is readable and holds the placeholder (so
	// the scan of every process's is not vacuous), or it is not readable at all, which is the stronger answer.
	const environ = said["environ-values"] === "0" && (said["environ-readable"] === "no" || (said["environ-readable"] === "yes" && said["environ-self"] === "1"));
	const ok = said.envkey === "placeholder" && said.envtoken === "placeholder" && environ && swapped && !leaked && git;
	console.log(`${ok ? "ok     " : "FAIL   "} the credentials: ${JSON.stringify({ envkey: said.envkey, envtoken: said.envtoken, environReadable: said["environ-readable"], environSelf: said["environ-self"], environValues: said["environ-values"], header: said.header, git: said.git, swapped, leaked, gitBasic: git })}`);
	if (!ok) failed = true;
}
// Issue #704 part 3: a project secret bundle, through the bundle's own gate and stage as the processor drives them: one
// variable bound to host.docker.internal (the stand-in's second alias, a model endpoint of this policy) as a
// placeholder, one plain. The stand-in is reachable only as a model endpoint (a port other than 443), which the
// processor's credential-host rule (review round 1, H2) refuses as a bundle host, so the gate is asked here without the
// processor's hosts: what this case proves is the venue's binding and file channel beneath that rule. The plain value
// must reach the job directory's bundle-env.json and no command line, and neither value the gateway's own log (H1). Read from inside: the placeholder in the env and in /proc/self/environ and no process holding
// its value, the plain value visible, the real value received by the stand-in at its own host only, and the job's own
// model key refused at the bundle's host (an endpoint binds one provider). Then a KILLED job's providers: a worker
// process that dies with a bundled sandbox running leaves the sandbox and both its providers, and the reaper's sweep
// removes all three.
const BUNDLE_ENDPOINTS = { BUNDLE_TOKEN: { host: "host.docker.internal", auth: "bearer" } };
const BUNDLE_VALUES = { BUNDLE_TOKEN: "conformance-bundle-not-a-token", BUNDLE_PLAIN: "conformance-bundle-plain-value" };
const BUNDLE_KEYS = { endpoints: BUNDLE_ENDPOINTS, plain: ["BUNDLE_PLAIN"] };
const providersListed = async () => {
	const listed = await run("openshell", ["provider", "list", "--label-selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "-o", "json"], 30_000);
	return listed.code === 0 ? (JSON.parse(listed.stdout).providers ?? []).map((p) => p.name) : null;
};
{
	const gate = await backend.bundleGate(JOB, { endpoints: BUNDLE_ENDPOINTS, vars: BUNDLE_VALUES, shadowed: [], capabilities: ["bundleEnvFile"] });
	const refusedWide = await backend.bundleGate(JOB, { endpoints: { BUNDLE_TOKEN: { host: "example.com", auth: "bearer" } }, vars: null });
	output.set("last", "");
	const name = `pi-job-conformance-${nonce}-bundle`;
	const result = await backend.runContainer({ job: JOB, token: "conformance-probe-not-a-token", prepared: jobDirFor("bundle"), name, signal: new AbortController().signal, secrets: BUNDLE_VALUES, bundleKeys: BUNDLE_KEYS, size: { memMiB: 1024, cpuCenti: 100 } });
	const said = Object.fromEntries([...String(output.get("last")).matchAll(/^probe ([A-Za-z.-]+)[=:][ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	let seen = [];
	try {
		seen = nodeFs.readFileSync(process.env.STANDIN_LOG ?? "", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {}
	const at = (path) => seen.filter((e) => e.path === path);
	const swapped = at("/bundle-own").some((e) => e.authorization === `Bearer ${BUNDLE_VALUES.BUNDLE_TOKEN}`);
	// Refused by the supervisor before it forwards (403 credential_endpoint_mismatch), so the stand-in never saw them.
	const elsewhere = /^403$/.test(said.bother ?? "") && at("/bundle-elsewhere").length === 0;
	const keyRefused = /^403$/.test(said.bkey ?? "") && at("/key-at-bundle-host").length === 0;
	const leaked = seen.some((e) => /openshell:resolve/.test(e.authorization ?? ""));
	let gatewayLog = "";
	try {
		gatewayLog = nodeFs.readFileSync(process.env.GATEWAY_LOG ?? "", "utf8");
	} catch {}
	const logged = Object.values(BUNDLE_VALUES).some((v) => gatewayLog.includes(v));
	const ok = !logged && said.bcmdline === "0" && gate?.ok === true && gate.placeholders === 1 && gate.plain === 1 && refusedWide?.venueRefused?.reason === "openshell-bundle-endpoint-not-allowed" && result.code === 0 && said.btoken === "placeholder" && (said["benviron-readable"] === "no" || said.benviron === "1") && said["benviron-values"] === "0" && said.bplain === "file" && said.bown === "200" && swapped && elsewhere && keyRefused && !leaked;
	console.log(`${ok ? "ok     " : "FAIL   "} a secret bundle: ${JSON.stringify({ gate, wide: refusedWide?.venueRefused?.reason ?? null, exit: result.code, btoken: said.btoken, benvironReadable: said["benviron-readable"], benviron: said.benviron, benvironValues: said["benviron-values"], bplain: said.bplain, bcmdline: said.bcmdline, gatewayLogRead: gatewayLog.length > 0, logged, bown: said.bown, bother: said.bother, bkey: said.bkey, swapped, elsewhere, keyRefused, leaked })}`);
	if (!ok) failed = true;
	// Issue #712: the run's record-facing facts, from the real stage through runContainer's result to the record the
	// processor would write: copy mode, the policy's hosts (the allowlist's and both model endpoints'), the job's provider
	// and the bundle host's, and the keys they bound. Never a value.
	const record = buildRecord({ job: { id: "conformance", attemptsMade: 0, data: { ...JOB, backend: "openshell" } }, result: { outcome: "completed", exitCode: result.code, openshell: result.openshell }, startedAt: null, endedAt: null });
	const facts = record.openshell ?? null;
	// Exact, from the sources this run's policy was generated from (the same generator, so a host added or dropped by
	// the stage is a mismatch), and the keys: the job's provider binds ANTHROPIC_API_KEY, GH_TOKEN and GITHUB_TOKEN (the
	// token passed), the bundle host's BUNDLE_TOKEN; BUNDLE_PLAIN is a value by file and is not one.
	const policy = networkPolicyFor({ allowlist: POLICY_SOURCES.readAllowlist(), endpoints: POLICY_SOURCES.readEndpoints(), kind: JOB.kind, repo: JOB.repo });
	const wantHosts = [...new Set(Object.values(policy.network_policies ?? {}).flatMap((rule) => rule.endpoints.map((e) => e.host)))].sort();
	const factsOk = facts !== null && facts.mode === "copy" && JSON.stringify(facts.ruleHosts) === JSON.stringify(wantHosts) && facts.ruleHostCount === wantHosts.length && facts.providers === 2 && facts.placeholders === 4 && !Object.values(BUNDLE_VALUES).some((v) => JSON.stringify(record).includes(v));
	console.log(`${factsOk ? "ok     " : "FAIL   "} the run's record carries its openshell facts: ${JSON.stringify(facts)} (hosts wanted ${JSON.stringify(wantHosts)}, 2 providers, 4 placeholders)`);
	if (!factsOk) failed = true;
	const left = await providersListed();
	const tidy = left !== null && !left.some((p) => p.startsWith(sandboxNameOf(name)));
	console.log(`${tidy ? "ok     " : "FAIL   "} the bundle run's teardown deleted its providers: ${JSON.stringify(left)}`);
	if (!tidy) failed = true;
}
{
	// The killed job: a worker of its own, SIGKILLed while its bundled sandbox runs, so nothing of its teardown runs.
	const name = `pi-job-conformance-${nonce}-killed`;
	const sandbox = sandboxNameOf(name);
	const dirs = jobDirFor("sleep");
	const child = join(scratch, "killed-worker.mjs");
	nodeFs.writeFileSync(
		child,
		`import { pathToFileURL } from "node:url";
const [root, image, engine, name, jobDir] = process.argv.slice(2);
const { makeOpenshellBackend } = await import(pathToFileURL(root + "/worker/src/backend-openshell.mjs").href);
const b = makeOpenshellBackend({ image, engine, hostEnv: { ANTHROPIC_API_KEY: "conformance-probe-not-a-key" }, onOutput: () => {}, readAllowlist: () => ["api.anthropic.com", ".github.com"], readEndpoints: () => [{ id: "lab-a", host: "host.openshell.internal", port: 18080, slots: 1 }, { id: "lab-b", host: "host.docker.internal", port: 18080, slots: 1 }] });
await b.runContainer({ job: ${JSON.stringify(JOB)}, token: "conformance-probe-not-a-token", prepared: { jobDir, workspace: jobDir + "/workspace", live: { hostDir: jobDir + "/session" } }, name, signal: new AbortController().signal, secrets: ${JSON.stringify(BUNDLE_VALUES)}, bundleKeys: ${JSON.stringify(BUNDLE_KEYS)}, size: { memMiB: 1024, cpuCenti: 100 } });
`,
	);
	const worker = spawn(process.execPath, [child, root, probeImage, engine, name, dirs.jobDir], { stdio: "ignore" });
	let ready = false;
	for (let i = 0; i < 180 && !ready; i++) {
		const got = await run("openshell", ["sandbox", "get", sandbox, "-o", "json"], 15_000);
		ready = got.code === 0 && JSON.parse(got.stdout).phase === "Ready";
		if (!ready) await new Promise((r) => setTimeout(r, 1000));
	}
	// Running, not merely created: the exec has started once its sleep is in the sandbox's process list is not readable
	// from here, so a few seconds past Ready, as the abort probe waits.
	await new Promise((r) => setTimeout(r, 5000));
	const before = await providersListed();
	worker.kill("SIGKILL");
	const reaped = await backend.reap();
	let after = null;
	let sandboxGone = false;
	for (let i = 0; i < 30; i++) {
		after = await providersListed();
		sandboxGone = (await run("openshell", ["sandbox", "get", sandbox, "-o", "json"], 15_000)).code !== 0;
		if (after !== null && sandboxGone && !after.some((p) => p.startsWith(sandbox))) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
	const held = before !== null && before.includes(sandbox) && before.includes(`${sandbox}-b0`);
	const ok = ready && held && reaped?.reaped === true && sandboxGone && after !== null && !after.some((p) => p.startsWith(sandbox));
	console.log(`${ok ? "ok     " : "FAIL   "} a killed bundled job's sandbox and providers are gone after the sweep: ${JSON.stringify({ ready, before, reaped, sandboxGone, after })}`);
	if (!ok) failed = true;
}

// readOnlyJobInputs is not in the harness's read-back list (the transfer check covers its word); this script reads it.
console.log(`${readings.readOnlyJobInputs?.ok ? "ok     " : "FAIL   "} readOnlyJobInputs (live): ${readings.readOnlyJobInputs?.detail}`);
if (!readings.readOnlyJobInputs?.ok) failed = true;
for (const [property, why] of Object.entries(UNVERIFIED_BY_THIS_HARNESS)) console.log(`not read ${property}: ${why}`);

// The real runner, keyed and offline, under a cost cap of 0: its own signed exit line, the session brought back.
{
	const logs = join(scratch, "logs");
	nodeFs.mkdirSync(logs);
	// Under the same policy as the probes: with no rule no provider is made and the key reaches the job not at all
	// (`openshell_secrets_unbound`), which is the venue working, and a runner with no key to read.
	// Issue #686: the REAL publisher (live-transcript.mjs, the opener start.mjs builds), transcripts on and progress off,
	// over a Valkey stand-in that records every XADD in memory, so what is checked is the path a job's lines take: the
	// runner's mirror, the exec's stderr, the demux's verification under this attempt's key, the stdio source.
	const xadds = [];
	const redis = {
		status: "ready",
		multi() {
			const tx = { del: () => tx, pexpire: () => tx, xadd: (_key, ...args) => (xadds.push(args), tx), exec: async () => [] };
			return tx;
		},
	};
	const openLiveTranscript = makeLiveTranscriptOpener({ redis, transcripts: true, progress: false });
	const events = [];
	const real = bundleFor(image, { ...POLICY_SOURCES, openJobLog: makeLogSink({ logsDir: logs, enabled: false }), openLiveTranscript, log: (event, fields) => events.push([event, fields]) });
	const dirs = jobDirFor("Reply with the single word ok.");
	// This run's output alone, so the record check below reads nothing an earlier probe wrote.
	output.set("last", "");
	const result = await real.runContainer({ job: { ...JOB, maxCostMicros: 0 }, prepared: dirs, name: `pi-job-conformance-${nonce}-runner`, signal: new AbortController().signal, exitAuth: true, transcriptStderr: true, jobId: `conformance-${nonce}`, size: { memMiB: 2048, cpuCenti: 200 } });
	const session = nodeFs.readFileSync(join(dirs.jobDir, "session", "current.jsonl"), "utf8");
	const ok = result.code === 2 && result.exitReason === "cost-cap" && result.exitAuth === "verified" && session.length > 0;
	console.log(`${ok ? "ok     " : "FAIL   "} the real runner: exit ${result.code}, reason ${result.exitReason}, exit line ${result.exitAuth}, session ${session.length} bytes`);
	// Every published entry's kind (the field list is flat: "kind", <kind>, "ts", ...): at least one from the session (the
	// prompt's `user` entry is the one a cost cap of 0 always leaves), the `end`, and no forged or broken record on the way.
	const kinds = xadds.map((fields) => fields[fields.indexOf("kind") + 1]);
	const fromSession = kinds.filter((k) => k !== "end" && k !== "skipped").length;
	const unverified = events.filter(([e]) => e === "transcript_record_unverified" || e === "transcript_record_dropped" || e === "transcript_demux_failed" || e === "live_transcript_skipped");
	const piped = fromSession > 0 && kinds.at(-1) === "end" && unverified.length === 0 && !/\x1epidt /.test(String(output.get("last") ?? ""));
	console.log(`${piped ? "ok     " : "FAIL   "} the live transcript over stderr: ${fromSession} entries from the session (${[...new Set(kinds)].join(", ") || "none"}), ${unverified.length} skip, unverified or dropped events, records kept out of the output`);
	if (!piped) failed = true;
	if (!ok) console.log(String(output.get("last") ?? "").split("\n").slice(-15).join("\n"));
	if (!ok) failed = true;
}

// Issue #725 diagnostics: the model-call routes from a copy-mode sandbox under the probes' policy, printed and never
// asserted (the steering case below is the assertion). Run before it so its answer is in the log whatever it does.
{
	output.set("last", "");
	const result = await backend.runContainer({ job: JOB, prepared: jobDirFor("netpath"), name: `pi-job-conformance-${nonce}-netpath`, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const lines = String(output.get("last") ?? "").split("\n").filter((l) => l.startsWith("probe netpath "));
	console.log(`diag    the model-call routes (exit ${result.code}):\n${lines.map((l) => `          ${l.slice("probe netpath ".length)}`).join("\n") || "          none printed"}`);
}

// Issue #730 investigation (E1-E4): all diag, none asserted. A helper runs one probe prompt on one image and prints
// every `probe <...>` line the run wrote, so a build or run failure is a visible line too.
const invRun = async (label, img, prompt, prefix) => {
	output.set("last", "");
	let code = "no-run";
	try {
		code = (await bundleFor(img, POLICY_SOURCES).runContainer({ job: JOB, prepared: jobDirFor(prompt), name: `pi-job-conformance-${nonce}-${label}`, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 200 } })).code;
	} catch (e) {
		code = `threw ${e?.reason ?? e?.message ?? e}`;
	}
	const lines = String(output.get("last") ?? "").split("\n").filter((l) => l.startsWith(`probe ${prefix}`)).map((l) => l.slice("probe ".length));
	console.log(`diag    #730 ${label} (exit ${code}):\n${lines.map((l) => `          ${l}`).join("\n") || "          none printed"}`);
};
// E1: the mechanism's inputs (dumpable bit, modes, Yama). E2: does a dumpable runner-node (0755) reach the model, and
// does a fresh policy-listed 0755 path? E3/E4: a tool child's network reach and its reads of the parent, with the
// parent dumpable (node) and nondumpable (runner), on the shipped 0711 image.
await invRun("e1", probeImage, "inv-e1", "e1");
{
	const name = `pi-job-conformance-${nonce}-e1log`;
	const sandbox = sandboxNameOf(name);
	output.set("last", "");
	let done = false;
	const running = bundleFor(probeImage, POLICY_SOURCES).runContainer({ job: JOB, prepared: jobDirFor("netpath"), name, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 200 } }).catch((e) => ({ code: `threw ${e?.message ?? e}` })).finally(() => (done = true));
	const seen = new Set();
	while (!done) {
		const got = await run("openshell", ["logs", sandbox, "--source", "sandbox", "--level", "warn", "-n", "500"], 15_000);
		for (const l of `${got.stdout}\n${got.stderr}`.split("\n")) if (/notification denied|task-memory|EAI_AGAIN|binary/i.test(l)) seen.add(l.trim().slice(0, 400));
		await new Promise((r) => setTimeout(r, 1000));
	}
	await running;
	console.log(`diag    #730 e1 broker log (sandbox ${sandbox}, warn and up, matching lines):\n${[...seen].slice(0, 12).map((l) => `          ${l}`).join("\n") || "          none matched"}`);
}
await invRun("e2-runner0755", probeImage0755, "netpath", "netpath");
await invRun("e2-newpath", probeImageNewPath, "netpath-obs", "netpath");
// E2 (b): whether the fresh path is in the policy the stage generates from the variant's label (the same generator).
{
	const label = (await run(engine, ["image", "inspect", "--format", `{{index .Config.Labels "${NET_LABEL}"}}`, probeImageNewPath])).stdout.trim();
	const pol = networkPolicyFor({ allowlist: POLICY_SOURCES.readAllowlist(), endpoints: POLICY_SOURCES.readEndpoints(), kind: JOB.kind, repo: JOB.repo, binaries: label.split(",") });
	const listed = Object.values(pol.network_policies ?? {}).some((r) => (r.binaries ?? []).some((b) => b.path === "/opt/pi-dispatch/runner-observable"));
	console.log(`diag    #730 e2-newpath policy lists /opt/pi-dispatch/runner-observable: ${listed} (label has it: ${label.includes("runner-observable")})`);
}
await invRun("e34-parent-node", probeImage, "inv-child-node", "e");
await invRun("e34-parent-runner", probeImage, "inv-child-runner", "e");
await invRun("e34-parent-runner-dumpable", probeImage0755, "inv-child-runner", "e");

// Issue #686, part 2: the real runner STEERED over the exec's stdin. The real relay (inbox-relay.mjs) over an in-memory
// inbox holding one queued steer, the real publisher with the steer ack consumer (the opener start.mjs builds), and the
// bundle handed both, as start.mjs hands them. A fresh job's relay is released at the spawn (an empty upload has no
// prior line), so the FIRST message's frame travels right behind the key frame, before the runner has loaded pi, and pi
// takes it at the start of its loop, before its first model call.
// A SECOND message is queued the moment the first one's ack arrives, and the relay is ticked from that very mark, so its
// frame is written mid-run, on the open pipe.
// Issue #725: the model is a zero-rated fake at the workflow's stand-in (provider `steer-fake`, keyless, every rate 0).
// Its answer to the first request is HELD until this script touches STEER_SIGNAL_FILE, which it does once the relay has
// written the second frame, and then asks for `read` of the job's prompt file; its answer to a request carrying that
// tool result says "done". This case used to run on the job provider under a cost cap of 0, which refuses the only
// model call, so the run ended at the cap within milliseconds of the first ack; the second message then raced the exit
// line's close of stdin (M1) and was left `queued` with one frame written on some runs. Now the run cannot pass its
// first model call before the second frame is on the pipe, and pi delivers it with its second request, so both are
// asserted delivered. Still at zero spend: the cap
// stays 0 and a zero-rated model runs under it (usage-meter.mjs, `callCostBound`), and no cost refusal may appear.
// Asserted: the job ends clean (exit 0) on its own signed exit line, whose deliveredIds names BOTH messages; the acks
// came back through the stderr transcript (the ack consumer verified them); the inbox calls both delivered; the relay
// wrote two frames; and the stream never broke and carried no forged frame. The delivery with spend is still shown by
// the runner's own test (image/runner/test/inbox.test.mjs, "the real run-job on the stdin frame channel").
// The keyless provider's declaration, as an operator writes one for a local model server (docs/egress.md, "Local model
// servers"): `apiKey` is the keyless placeholder the worker fills, so no job credential (ANTHROPIC_API_KEY here) is
// given to this provider or made into an OpenShell provider for it.
const STEER_FAKE_MODEL = { id: "m1", name: "m1", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } };
const STEER_FAKE_MODELS = { providers: { "steer-fake": { baseUrl: "http://host.openshell.internal:18080/v1", apiKey: KEYLESS_API_KEY, api: "openai-completions", models: [STEER_FAKE_MODEL] } } };
{
	const logs = join(scratch, "logs-steer");
	nodeFs.mkdirSync(logs);
	const xadds = [];
	const redis = {
		status: "ready",
		multi() {
			const tx = { del: () => tx, pexpire: () => tx, xadd: (_key, ...args) => (xadds.push(args), tx), exec: async () => [] };
			return tx;
		},
	};
	const id = randomBytes(16).toString("hex");
	const second = randomBytes(16).toString("hex");
	const state = { [id]: "queued" };
	let relayRef = null;
	const entries = [{ v: 1, id, mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "Before anything else, reply with the single word steered.", at: Date.now() }];
	const marks = [];
	const inbox = {
		resetClosedInbox: async () => ({ reset: false }),
		registerLive: async () => ({ ok: true }),
		refreshLive: async () => ({ ok: true }),
		holdLive: async () => ({ held: true }),
		readInbox: async () => ({ entries: entries.map((e) => ({ ...e })), state: { ...state }, closed: false }),
		markState: async ({ id: mid, from, to }) => {
			marks.push([from.join("|"), to]);
			if (!from.includes(state[mid])) return { ok: false, prior: state[mid] };
			const prior = state[mid];
			state[mid] = to;
			// The first ack: queue the second message and have the relay write it now, mid-run.
			if (mid === id && to === "delivered" && !(second in state)) {
				entries.push({ v: 1, id: second, mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "And a second thing, sent while you run.", at: Date.now() });
				state[second] = "queued";
				void relayRef?.tick();
			}
			return { ok: true, prior };
		},
	};
	const events = [];
	const log = (event, fields) => events.push([event, fields]);
	const opener = makeLiveTranscriptOpener({ redis, transcripts: true, progress: false, steer: true });
	const handles = [];
	const openLiveTranscript = (args) => {
		const h = opener(args);
		if (h) handles.push(h);
		return h;
	};
	const openInboxRelay = (args) => (relayRef = makeInboxRelay({ redis: {}, host: "conformance", log, pollMs: 500, inbox, ...args }));
	// The stand-in's release (the workflow sets the path for both): removed first so a rerun starts held, touched once
	// the relay has written the second frame. Without the variable the stand-in answers after its 30 s cap anyway.
	// The stand-in's completion requests so far (the diagnostics above sent some), so a failure reports this run's own.
	const standinCompletions = () => {
		let seen = [];
		try {
			seen = nodeFs.readFileSync(process.env.STANDIN_LOG ?? "", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		} catch {}
		return seen.filter((e) => e.path === "/v1/chat/completions").map((e) => `${e.method} ${e.path}`);
	};
	const completionsBefore = standinCompletions().length;
	const signalFile = process.env.STEER_SIGNAL_FILE ?? "";
	if (signalFile !== "") nodeFs.rmSync(signalFile, { force: true });
	const signal = setInterval(() => {
		if ((relayRef?.counts().written ?? 0) < 2) return;
		clearInterval(signal);
		if (signalFile !== "") nodeFs.writeFileSync(signalFile, "");
	}, 50);
	// The overlay holding the fake's models.json, uploaded with the job in copy mode as an operator's overlay is.
	const overlay = join(scratch, "overlay-steer");
	nodeFs.mkdirSync(overlay);
	nodeFs.writeFileSync(join(overlay, "models.json"), `${JSON.stringify(STEER_FAKE_MODELS)}\n`);
	// The pickup's endpoint snapshot, as the processor hands it (index.mjs): the same two endpoints the policy is built
	// from (so the policy is the probes'), the stand-in's first alias declared keyless. The credential gate inside
	// runContainer reads it: a provider pi does not know passes only as keyless (env-allowlist.mjs, `keylessEndpointsFor`).
	const modelEndpoints = { endpoints: POLICY_SOURCES.readEndpoints().map((e) => ({ ...e, keyless: e.id === "lab-a" })), models: STEER_FAKE_MODELS };
	const real = bundleFor(image, { ...POLICY_SOURCES, globalPiDir: overlay, openJobLog: makeLogSink({ logsDir: logs, enabled: false }), openLiveTranscript, openInboxRelay, log });
	const dirs = jobDirFor("Read your prompt file, then reply with the single word done.");
	output.set("last", "");
	const steerJob = { ...JOB, provider: "steer-fake", model: "m1", maxTurns: 2, maxCostMicros: 0, steer: true };
	const result = await real.runContainer({ job: steerJob, prepared: dirs, modelEndpoints, name: `pi-job-conformance-${nonce}-steer`, signal: new AbortController().signal, exitAuth: true, transcriptStderr: true, steerStdin: true, jobId: `conformance-steer-${nonce}`, size: { memMiB: 2048, cpuCenti: 200 } });
	clearInterval(signal);
	const said = String(output.get("last") ?? "");
	const ackVerified = handles[0]?.stats?.().steer?.verified ?? 0;
	const exitLine = said.split("\n").filter((l) => l.startsWith('{"event":"exit"')).at(-1) ?? "";
	let exit = null;
	try {
		exit = JSON.parse(exitLine);
	} catch {}
	const deliveredIds = Array.isArray(exit?.steer?.deliveredIds) ? exit.steer.deliveredIds : [];
	const named = deliveredIds.includes(id) && deliveredIds.includes(second);
	// At zero spend by construction: the runner's guard refused nothing (no `cost_refused` line, the exit line's own
	// `costRefused` 0, measured so on the runner against this stand-in), and the run did not end at the cap.
	const refusedCost = /"event":"cost_refused"/.test(said) || (exit?.tokens?.costRefused ?? 0) !== 0 || (exit?.tokens?.cost ?? 0) !== 0 || result.exitReason === "cost-cap";
	const broken = /"event":"steer_(stream_broken|frame_unverified|stdin_shared)"/.test(said) || events.some(([e]) => e === "steer_relay_fault" || e === "steer_skipped" || e === "steer_frame_refused" || e === "steer_acks_unread");
	const secondOutcome = state[second] ?? "never queued";
	const written = relayRef?.counts().written ?? 0;
	// Delivered and nothing less: the exit line names it (so the runner saw pi persist it), and the worker marks what a
	// verified exit line names before the relay stops, after draining the acks, so `written` here would be a defect.
	const secondDelivered = secondOutcome === "delivered" && written >= 2;
	const ok = result.code === 0 && result.exitAuth === "verified" && !refusedCost && (result.steer?.delivered ?? 0) >= 2 && ackVerified >= 2 && named && state[id] === "delivered" && !broken && secondDelivered;
	console.log(`${ok ? "ok     " : "FAIL   "} steering over the exec's stdin: exit ${result.code} ${result.exitReason ?? "none"} (${result.exitAuth}), cost refused ${refusedCost}, runner delivered ${result.steer?.delivered ?? "none"}, acks verified over stderr ${ackVerified}, exit line names both ${named} (${JSON.stringify(deliveredIds)}), inbox says ${state[id]}; the mid-run second: ${secondOutcome} (${written} frames written, 2 wanted); marks ${JSON.stringify(marks)}, broken or refused ${broken}`);
	if (!ok) {
		console.log(said.split("\n").slice(-20).join("\n"));
		console.log(JSON.stringify(events.filter(([e]) => /steer|transcript/.test(e))));
		// Whether the model calls reached the stand-in at all (issue #725): its log's completion requests, by method and
		// path only (the log holds no body; the credential headers are left out here too).
		const calls = standinCompletions().slice(completionsBefore);
		console.log(`the stand-in saw ${calls.length} completion request(s) during this run${calls.length > 0 ? `: ${JSON.stringify(calls)}` : ""}`);
		failed = true;
	}
}

// Issue #730 E5: the bind pass (openshell-bind-conformance.mjs, after the gateway restart) reruns E1-E4 on these same
// images, so they are kept and named in a file (the default probe under a tag of its own, since its own is removed).
{
	const keep = `pi-dispatch-openshell-probe-inv:${nonce}`;
	await run(engine, ["tag", probeImage, keep]);
	const file = process.env.INV730_FILE ?? join(process.env.RUNNER_TEMP ?? scratch, "inv730.json");
	try {
		nodeFs.writeFileSync(file, `${JSON.stringify({ probe: keep, runner0755: probeImage0755, newPath: probeImageNewPath })}\n`);
	} catch (e) {
		console.log(`diag    #730 could not hand the images to the bind pass: ${e.code ?? e.message}`);
	}
}
await run(engine, ["image", "rm", "-f", probeImage]);
nodeFs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
