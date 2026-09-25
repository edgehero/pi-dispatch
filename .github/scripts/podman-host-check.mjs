#!/usr/bin/env node
/**
 * Issue #355: re-measure docs/podman.md's "Measured on a real host" table on a real host, and print its rows.
 *
 * The nested lab cannot answer SELinux, netavark's nftables driver or systemd health checks, so this runs on the host
 * itself: an SELinux-ENFORCING Fedora or RHEL machine with systemd, rootful Podman behind its socket, and the real
 * docker CLI pointed at it. Run it as the WORKER's account, from the deployment directory (the one holding `.env`, with
 * PI_EGRESS armed and the compose egress profile up), on a host that is not serving jobs: it restarts the proxy. doctor
 * reads `.env` itself; this script reads only the shell's environment, so export PI_EGRESS_PROXY too if you renamed it.
 *
 *   node <repo>/.github/scripts/podman-host-check.mjs <image>
 *
 * It refuses to record anything unless the host is what the table claims (SELinux enforcing, systemd running or
 * degraded, netavark on nftables, cgroup v2, rootful Podman through a local docker endpoint). Then it runs each check,
 * prints PASS or FAIL per check, and at the end the table rows whose checks all passed, ready to paste between the
 * PODMAN-HOST-ROWS markers. Any FAIL exits 1; a refused preflight exits 2.
 *
 * netavark's firewall driver is not in `docker info`. The script looks for it in `podman --remote info` and otherwise
 * in a log you pass as PI_HOST_CHECK_NETAVARK_LOG, made as root with:
 *
 *   podman network create hc && podman --log-level=debug run --rm --network hc <image> true 2>&1 | grep -i firewall > log
 *
 * Deliberately plain: one helper that runs a command, one that records a check, and the checks in order. The worker's
 * own modules are imported where they already answer the question (the job argv builder, the egress helpers, the
 * daemon facts), so what is measured is what a job gets rather than a copy of it.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const image = process.argv[2];
if (!image) {
	console.error("usage: podman-host-check.mjs <image>");
	process.exit(64);
}

const { makeDockerEndpointResolver } = await load("worker/src/backend-local.mjs");
const { buildDockerRunArgs } = await load("worker/src/docker-run.mjs");
const { CONTAINER_HOME } = await load("worker/src/container-spec.mjs");
const { makeDaemonFactsReader, relabelsPrivateMounts } = await load("worker/src/job-user.mjs");
const { createJobNetworkWith, egressEnv, egressProxyName, makeEgressPreflight, removeJobNetworkWith } = await load("worker/src/egress.mjs");

const uid = process.getuid();
const gid = process.getgid();
const user = `${uid}:${gid}`;
const tag = `pd-hostcheck-${process.pid}`;
const today = new Date().toISOString().slice(0, 10);
const scratch = [];

/** Run a command without a shell. Never throws: `code` is null when it could not start or ran out of time. */
function run(cmd, args, { env = process.env, cwd, timeoutMs = 120_000 } = {}) {
	return new Promise((done) => {
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			done({ code: null, stdout, stderr: `${stderr}${error.message}`, ms: Date.now() - started });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code, stdout, stderr, ms: Date.now() - started });
		});
	});
}
const docker = (args, opts) => run("docker", args, opts);
const firstLine = (text) => String(text).trim().split("\n")[0] ?? "";

/** A scratch directory under `base`, removed at the end whatever happened. */
function scratchDir(base, prefix) {
	const dir = mkdtempSync(join(base, `${tag}-${prefix}-`));
	scratch.push(dir);
	return dir;
}
process.on("exit", () => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const checks = [];
function record(id, ok, detail) {
	checks.push({ id, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

// --- 1. preflight: record nothing unless the host is the one the table describes -----------------------------------
const refusals = [];
if (uid === 0) refusals.push("run this as the worker's account, not root");

const QUICK = { timeoutMs: 20_000 };
const enforce = await run("getenforce", [], QUICK);
const selinuxMode = enforce.code === 0 ? enforce.stdout.trim() : existsSync("/sys/fs/selinux/enforce") && readFileSync("/sys/fs/selinux/enforce", "utf8").trim() === "1" ? "Enforcing" : "unknown";
if (selinuxMode !== "Enforcing") refusals.push(`SELinux is ${selinuxMode}, not Enforcing`);

// `is-system-running` exits non-zero for `degraded`, so the word is read, not the code. Degraded is fine: one failed
// unit elsewhere does not stop systemd running timers.
const systemState = (await run("systemctl", ["is-system-running"], QUICK)).stdout.trim();
if (systemState !== "running" && systemState !== "degraded") refusals.push(`systemd is ${systemState || "not answering"}, not running or degraded`);

const endpoint = await makeDockerEndpointResolver()();
if (endpoint.local !== true) refusals.push(`the docker endpoint is not local (${endpoint.reason ?? "no reason given"})`);
const daemon = await makeDaemonFactsReader()();
const facts = daemon.answered ? daemon.facts : null;
if (facts?.podman !== true || facts.shape !== "docker") refusals.push("the daemon is not Podman through the real docker CLI");
if (facts?.rootless !== false) refusals.push("the daemon is not rootful");
if (facts?.selinux !== true) refusals.push("the daemon does not report name=selinux");

const cgroup = (await docker(["info", "--format", "{{.CgroupVersion}}"], QUICK)).stdout.trim();
if (cgroup !== "2") refusals.push(`cgroup version is ${cgroup || "unknown"}, not 2`);

// The firewall driver: Podman's own info through the same socket if it says, else the log the operator made as root.
const socketPath = /^unix:\/\/\//.test(endpoint.endpoint ?? "") ? endpoint.endpoint : "unix:///run/podman/podman.sock";
const podmanInfo = await run("podman", ["--remote", "--url", socketPath, "info", "--format", "json"], QUICK);
let firewall = /"firewall[^"]*"\s*:\s*"(\w+)"/i.exec(podmanInfo.stdout)?.[1] ?? null;
if (!firewall && process.env.PI_HOST_CHECK_NETAVARK_LOG) {
	firewall = /Using (\w+) firewall driver/.exec(readFileSync(process.env.PI_HOST_CHECK_NETAVARK_LOG, "utf8"))?.[1] ?? null;
}
if (firewall !== "nftables") refusals.push(`netavark's firewall driver is ${firewall ?? "unknown"}, not nftables (see PI_HOST_CHECK_NETAVARK_LOG in this file's header)`);

if (refusals.length > 0) {
	console.error(`podman-host-check: refusing to record anything on this host:\n  - ${refusals.join("\n  - ")}`);
	process.exit(2);
}
if (!relabelsPrivateMounts(facts, endpoint)) {
	console.error("podman-host-check: the worker's own rule says this host needs no relabel, which contradicts the preflight");
	process.exit(2);
}

// --- 2. versions, for the page's "The host" paragraph ---------------------------------------------------------------
const podmanVersion = (await docker(["version", "--format", "{{.Server.Version}}"])).stdout.trim();
console.log("Versions:");
const osRelease = existsSync("/etc/os-release") ? /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync("/etc/os-release", "utf8"))?.[1] : null;
console.log(`  ${osRelease ?? "unknown OS"}, kernel ${firstLine((await run("uname", ["-r"])).stdout)}, SELinux ${selinuxMode}, systemd ${systemState}, cgroup v${cgroup}, netavark firewall ${firewall}`);
console.log(`  ${firstLine((await run("systemctl", ["--version"])).stdout)}`);
for (const line of (await run("rpm", ["-q", "podman", "netavark", "aardvark-dns", "crun", "conmon", "selinux-policy", "container-selinux"])).stdout.trim().split("\n")) console.log(`  ${line}`);
console.log(`  docker client ${firstLine((await docker(["version", "--format", "{{.Client.Version}}"])).stdout)}, server ${podmanVersion}, ${firstLine((await docker(["compose", "version"])).stdout)}`);
console.log(`  worker account ${user}, image ${image}`);

// --- 3. the SELinux bind-mount matrix, through the docker CLI as the worker ------------------------------------------
// One FRESH directory per option, because `:z` and `:Z` relabel on the host and would make every later row pass.
const PROBE = [
	"ls /p >/dev/null 2>&1 && echo L-ok || echo L-denied",
	"cat /p/f >/dev/null 2>&1 && echo R-ok || echo R-denied",
	"touch /p/w 2>/dev/null && echo W-ok || echo W-denied",
].join("\n");
// Every container gets its own name: `--rm` removes one a moment AFTER the CLI returns, so a reused name can collide.
let probes = 0;
const probeMount = async (dir, option) => {
	const r = await docker(["run", "--rm", `--name=${tag}-probe-${++probes}`, `--user=${user}`, "--network=none", "--entrypoint", "sh", "-v", `${dir}:/p${option}`, image, "-c", PROBE]);
	return r.code === 0 ? r.stdout.trim().split(/\s+/).join(" ") : `did not run (exit ${r.code}): ${firstLine(r.stderr)}`;
};
const labelOf = async (dir) => (await run("stat", ["--format=%C", dir])).stdout.trim();
const SHARED = /:container_file_t:s0$/;
const PRIVATE = /:container_file_t:s0:c\d+,c\d+$/;
const MATRIX = [
	{ option: "", want: "L-denied R-denied W-denied" },
	{ option: ":ro", want: "L-denied R-denied W-denied" },
	{ option: ":z", want: "L-ok R-ok W-ok", label: SHARED },
	{ option: ":Z", want: "L-ok R-ok W-ok", label: PRIVATE },
	{ option: ":ro,Z", want: "L-ok R-ok W-denied", label: PRIVATE },
];
const bases = [["tmp", "/tmp"], ["home", homedir()]];
const varLib = process.env.PI_HOST_CHECK_VAR_LIB ?? "/var/lib";
try {
	accessSync(varLib, constants.W_OK);
	bases.push(["varlib", varLib]);
} catch {
	console.log(`NOTE: ${varLib} is not writable by this account, so the /var/lib rows are skipped (set PI_HOST_CHECK_VAR_LIB to a directory under /var/lib this account owns)`);
}
let lockoutDir = null;
for (const [name, base] of bases) {
	for (const { option, want, label } of MATRIX) {
		const dir = scratchDir(base, `sel-${name}`);
		writeFileSync(join(dir, "f"), "pd-hostcheck\n");
		const before = await labelOf(dir);
		const seen = await probeMount(dir, option);
		const after = await labelOf(dir);
		const labelOk = label ? label.test(after) : after === before;
		record(`S-${name}${option || ":none"}`, seen === want && labelOk, `${dir}${option} -> ${seen} | label ${before} -> ${after}`);
		if (option === ":Z" && !lockoutDir) lockoutDir = dir;
	}
}
// `:Z` is private: a second container mounting the same folder with no option is locked out of it.
if (lockoutDir) {
	const seen = await probeMount(lockoutDir, "");
	record("S-lockout", seen.startsWith("L-denied"), `a second container on ${lockoutDir} after :Z -> ${seen}`);
}

// --- 4. SecurityOptions --------------------------------------------------------------------------------------------
const secopts = (await docker(["info", "--format", "{{json .SecurityOptions}}"])).stdout.trim();
let options = [];
try {
	options = JSON.parse(secopts);
} catch {}
record("SECOPT", options.some((o) => o.split(",").includes("name=selinux")) && !options.some((o) => o.split(",").includes("name=rootless")), secopts);

// --- 5. the runner's refusals, with the argv a job gets -------------------------------------------------------------
// A /job the worker would make (0700, relabelled), and a workspace or overlay it would NOT relabel. The control has
// everything relabelled and must get past its inputs to the auth check, so a refusal is not something else failing.
const RUNNER_ENV = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-5-20250929", PI_MAX_TURNS: "1", HOME: CONTAINER_HOME };
const jobDir = scratchDir(homedir(), "job");
writeFileSync(join(jobDir, "prompt.md"), "pd-hostcheck\n");
const runner = async (name, opts) => {
	const r = await docker(buildDockerRunArgs({ image, name: `${tag}-${name}`, env: RUNNER_ENV, jobDir, network: "none", user, relabel: true, ...opts }));
	return { code: r.code, text: `${r.stdout}${r.stderr}` };
};
const ownWorkspace = scratchDir(homedir(), "ws-own");
const control = await runner("control", { workspace: ownWorkspace, workspaceOwned: true });
record("R-control", control.code === 2 && /no configured auth/.test(control.text), `everything relabelled -> exit ${control.code}, ${/no configured auth/.test(control.text) ? "reached the auth check" : firstLine(control.text)}`);
const operatorFolder = scratchDir(homedir(), "ws-operator");
const local = await runner("local", { workspace: operatorFolder, workspaceOwned: false });
record("R-local", local.code === 2 && /job-inputs-unreadable/.test(local.text) && /\/workspace/.test(local.text), `unlabelled local folder -> exit ${local.code}, ${/job-inputs-unreadable/.test(local.text) ? "job-inputs-unreadable" : "no job-inputs-unreadable (does the image's runner predate the /workspace check?)"}`);
const overlay = scratchDir(homedir(), "overlay");
const global = await runner("overlay", { workspace: scratchDir(homedir(), "ws-own2"), workspaceOwned: true, globalPiDir: overlay });
record("R-overlay", global.code === 2 && /job-inputs-unreadable/.test(global.text) && /\/opt\/pi-global/.test(global.text), `unlabelled overlay -> exit ${global.code}, ${/job-inputs-unreadable/.test(global.text) ? "job-inputs-unreadable" : firstLine(global.text)}`);

// --- 6. the job-user end to end, for a jobs dir under /tmp and under $HOME -------------------------------------------
for (const [name, base] of [["tmp", "/tmp"], ["home", homedir()]]) {
	const jobsDir = scratchDir(base, "jobs");
	const e2e = await run(process.execPath, [join(root, ".github/scripts/job-user-e2e.mjs"), image], { env: { ...process.env, PI_JOBS_DIR: jobsDir }, timeoutMs: 15 * 60_000 });
	const lines = `${e2e.stdout}${e2e.stderr}`.trim().split("\n");
	record(`E2E-${name}`, e2e.code === 0, `${jobsDir} -> exit ${e2e.code}: ${e2e.code === 0 ? lines.at(-1) : lines.find((l) => /Error|Permission denied/.test(l)) ?? lines.at(-1)}`);
}

// --- 7. health under systemd: restart the proxy and watch its own timer bring it to healthy ------------------------
const proxy = egressProxyName(process.env);
const inspect = async (name, format) => (await docker(["inspect", "--format", format, name])).stdout.trim();
const parseStart = (value) => Date.parse(String(value).replace(/(\.\d{3})\d+/, "$1"));
const restartedAt = Date.now();
const restart = await docker(["restart", proxy]);
let health = null;
let healthyAfter = null;
for (let waited = 0; restart.code === 0 && waited <= 180; waited += 5) {
	try {
		health = JSON.parse(await inspect(proxy, "{{json .State.Health}}"));
	} catch {
		health = null;
	}
	const fresh = (health?.Log ?? []).filter((entry) => parseStart(entry.Start) >= restartedAt);
	if (health?.Status === "healthy" && healthyAfter === null) healthyAfter = Math.round((Date.now() - restartedAt) / 1000);
	// Two checks since the restart, and nobody ran either by hand: the timer is what is running them.
	if (healthyAfter !== null && fresh.length >= 2) break;
	await new Promise((r) => setTimeout(r, 5000));
}
const freshRuns = (health?.Log ?? []).filter((entry) => parseStart(entry.Start) >= restartedAt).length;
record("H-proxy", healthyAfter !== null && freshRuns >= 2, `${proxy} restarted -> healthy after ${healthyAfter ?? "never"} s, ${freshRuns} check(s) since the restart`);
const proxyId = await inspect(proxy, "{{.Id}}");
const timers = (await run("systemctl", ["list-timers", "--all", "--no-legend", "--plain"])).stdout;
const timer = timers.split("\n").find((line) => proxyId && line.includes(proxyId));
record("H-timer", Boolean(timer), timer ? `transient timer ${/\S+\.timer/.exec(timer)?.[0]}` : `no timer names ${proxyId.slice(0, 12)}`);
const valkey = firstLine((await docker(["ps", "--filter", "label=com.docker.compose.service=valkey", "--format", "{{.Names}}"])).stdout);
const valkeyHealth = valkey ? await inspect(valkey, "{{.State.Health.Status}}") : "not running";
record("H-valkey", valkeyHealth === "healthy", `${valkey || "valkey"} -> ${valkeyHealth}`);

// The compose file's config mounts: the proxy is healthy only if squid read its config, and the source is relabelled.
let mounts = [];
try {
	mounts = JSON.parse(await inspect(proxy, "{{json .Mounts}}"));
} catch {}
// Both of the proxy's sources; the receiver's triggers.json carries the same option but is not started here.
const composeSources = [];
for (const destination of ["/etc/squid/squid.conf", "/etc/pi-dispatch/allowlist.conf"]) {
	const source = mounts.find((m) => m.Destination === destination)?.Source;
	composeSources.push({ source: source ?? `no ${destination} mount`, label: source ? await labelOf(source) : "" });
}
record("C-compose", composeSources.every((c) => SHARED.test(c.label)), composeSources.map((c) => `${c.source} -> ${c.label || "no label"}`).join("; "));

// --- 8. doctor --live, where it already answers -----------------------------------------------------------------------
const doctor = await run(process.execPath, [join(root, "worker/src/cli.mjs"), "doctor", "--live"], { timeoutMs: 10 * 60_000 });
// doctor's three marks (check, cross, warning sign), built from their code points rather than typed.
const [PASS_MARK, FAIL_MARK, WARN_MARK] = [0x2713, 0x2717, 0x26a0].map((code) => String.fromCharCode(code));
const doctorLines = doctor.stdout.split("\n").filter((line) => [PASS_MARK, FAIL_MARK, WARN_MARK].includes(line[0]) && line[1] === " ");
const fromDoctor = (id, pattern, what) => {
	const line = doctorLines.find((l) => pattern.test(l.slice(2)));
	record(id, line?.[0] === PASS_MARK, line ?? `doctor printed no line for ${what} (is PI_EGRESS armed in this directory's .env?)`);
};
fromDoctor("D-health", /^Egress proxy health: healthy/, "the proxy's health");
fromDoctor("EG1", /^Egress policy reaches the provider/, "the provider");
fromDoctor("EG2", /^Egress policy denies an unlisted host/, "an unlisted host");
fromDoctor("D-egress", /^read back on local: egress holds/, "egress");
fromDoctor("EG6", /^read back on local: jobToJobIsolation holds/, "jobToJobIsolation");
fromDoctor("D-localFolders", /^read back on local: localFolders holds/, "localFolders");
// Not one line of doctor's may be a failure: a check this script does not name (mountSet, ephemeral, isolation, a label
// line) failing is as much a failure of the host as one it does.
const doctorFailures = doctorLines.filter((line) => line[0] === FAIL_MARK);
record("D-clean", doctor.code !== null && doctorFailures.length === 0, doctorFailures.length === 0 ? "doctor --live printed no failing line" : doctorFailures.join(" | "));

// --- 9. egress rows doctor does not cover, on a job-shaped network ----------------------------------------------------
const network = `${tag}-net`;
const dockerCode = (args) => docker(args);
const listeners = [];
try {
	const built = await createJobNetworkWith(dockerCode, { network, proxy });
	record("EG-net", built, `${network} created --internal with ${proxy} attached`);
	const job = (name, script, env) => {
		const args = buildDockerRunArgs({ image, name: `${tag}-${name}`, env, workspace: scratchDir(homedir(), name), network, user, relabel: true, workspaceOwned: true, extraFlags: ["--entrypoint", "node"] });
		return docker([...args, "-e", script], { timeoutMs: 60_000 });
	};
	const proxied = { ...egressEnv({ proxy, armed: true }), HOME: CONTAINER_HOME };

	// EG3: api.github.com through the `.github.com` rule. Any HTTP status is an answer; a denied CONNECT is a thrown fetch.
	const gh = await job("eg3", 'fetch("https://api.github.com/zen").then(r=>console.log("status "+r.status),e=>console.log("error "+(e.cause?.code??e.message)))', proxied);
	record("EG3", /^status \d+/m.test(gh.stdout), `api.github.com through ${proxy} -> ${firstLine(gh.stdout) || firstLine(gh.stderr)}`);

	// EG4: a name resolved directly, with no proxy, fails at once rather than on a timeout.
	const direct = await job("eg4", 'const t=Date.now();require("node:dns").lookup("example.com",e=>console.log((e?"error "+e.code:"resolved")+" "+(Date.now()-t)+"ms"))', { HOME: CONTAINER_HOME });
	const [, outcome, ms] = /^(\S+ \S+|resolved) (\d+)ms/m.exec(direct.stdout) ?? [];
	record("EG4", Boolean(outcome?.startsWith("error")) && Number(ms) < 2000, `example.com without the proxy -> ${firstLine(direct.stdout) || firstLine(direct.stderr)}`);

	// EG5: the gateway is this host. A listener on 0.0.0.0 answers a job; one on 127.0.0.1 does not.
	const listen = (host) => new Promise((done) => {
		const server = createServer((socket) => socket.end("pd-hostcheck\n"));
		listeners.push(server);
		server.listen(0, host, () => done(server.address().port));
	});
	const openPort = await listen("0.0.0.0");
	const loopPort = await listen("127.0.0.1");
	let gateway = null;
	try {
		gateway = JSON.parse((await docker(["network", "inspect", "--format", "{{json .IPAM.Config}}", network])).stdout)?.[0]?.Gateway ?? null;
	} catch {}
	const dial = `const net=require("node:net");for(const p of [${openPort},${loopPort}]){const s=net.connect(p,${JSON.stringify(gateway)});s.setTimeout(3000,()=>{console.log(p+" timeout");s.destroy()});s.on("data",()=>{console.log(p+" answered");s.destroy()});s.on("error",e=>console.log(p+" "+e.code))}`;
	const host = gateway ? await job("eg5", dial, { HOME: CONTAINER_HOME }) : { stdout: "", stderr: "no gateway on the job network" };
	const answered = (port) => new RegExp(`^${port} answered`, "m").test(host.stdout);
	record("EG5", answered(openPort) && !answered(loopPort), `gateway ${gateway}: 0.0.0.0:${openPort} ${answered(openPort) ? "answered" : "did not answer"}, 127.0.0.1:${loopPort} ${answered(loopPort) ? "answered" : "did not answer"} (${host.stdout.trim().split("\n").join("; ") || firstLine(host.stderr)})`);
} finally {
	for (const server of listeners) server.close();
	await removeJobNetworkWith(dockerCode, { network, proxy });
}

// EG7: the worker's own pre-spend check, against a stopped container and an absent name. The real proxy is not
// touched: what is measured is how Podman answers the inspect the preflight asks, which is the part that could differ.
const stopped = `${tag}-stopped`;
await docker(["create", `--name=${stopped}`, "--entrypoint", "true", image]);
const stoppedAnswer = await makeEgressPreflight({ proxy: stopped, armed: true })();
const missingAnswer = await makeEgressPreflight({ proxy: `${tag}-absent`, armed: true })();
const liveAnswer = await makeEgressPreflight({ proxy, armed: true })();
await docker(["rm", "-f", stopped]);
record("EG7", stoppedAnswer.proxyStopped === stopped && missingAnswer.proxyMissing === `${tag}-absent` && liveAnswer.ok === true, `stopped -> ${JSON.stringify(stoppedAnswer)}, absent -> ${JSON.stringify(missingAnswer)}, the proxy -> ${JSON.stringify(liveAnswer)}`);

// --- 10. setup step 2: the worker reaches the socket through its group, and the override that re-creates it is in place
// (a reboot rebuilds /run/podman from it; this script does not reboot) -----------------------------------------------
const runPodman = statSync("/run/podman");
const override = existsSync("/etc/tmpfiles.d/podman.conf") ? readFileSync("/etc/tmpfiles.d/podman.conf", "utf8") : "";
const overrideLine = /^D! \/run\/podman 0710 root \S+$/m.exec(override)?.[0];
// Through the GROUP: this account is not root and not the directory's owner, so reaching the daemon means the group did it.
const viaGroup = uid !== 0 && runPodman.uid !== uid && process.getgroups().includes(runPodman.gid);
record("SOCK", Boolean(overrideLine) && (runPodman.mode & 0o777) === 0o710 && viaGroup && daemon.answered, `/run/podman ${(runPodman.mode & 0o777).toString(8)} gid ${runPodman.gid}${viaGroup ? " (one of this account's groups)" : " (NOT reached through a group of this account)"}, ${overrideLine ? `override "${overrideLine}"` : "no /etc/tmpfiles.d/podman.conf override"}, this account reached the daemon`);

// --- the table rows -------------------------------------------------------------------------------------------------
const ROWS = [
	{ row: "SELinux: the worker's own per-job mounts", result: "argv: :Z", needs: /^(S-|E2E-|D-clean$|D-localFolders$|R-control$)/ },
	{ row: "SELinux: an operator's local folder, unlabelled", result: "refused: job-inputs-unreadable", needs: /^(S-\w+:(none|ro)$|R-local$|R-control$)/ },
	{ row: "SELinux: the global overlay, unlabelled", result: "refused: job-inputs-unreadable", needs: /^(R-overlay|R-control)$/ },
	{ row: "SELinux: SecurityOptions carries name=selinux", result: "measured", needs: /^SECOPT$/ },
	{ row: "nftables: egress reaches the provider and denies an unlisted host", result: "measured", needs: /^(EG[1-57]|EG-net|D-egress)$/ },
	{ row: "nftables: jobToJobIsolation", result: "measured", needs: /^EG6$/ },
	{ row: "Health checks under systemd", result: "measured", needs: /^(H-|D-health$)/ },
	{ row: "SELinux: the compose file's config mounts", result: "argv: :ro,z", needs: /^(C-compose|H-proxy)$/ },
	{ row: "Setup step 2, the socket for the worker's group", result: "doc: /run/podman tmpfiles override", needs: /^SOCK$/ },
];
const failed = checks.filter((c) => !c.ok);
console.log("\nRows that held, for docs/podman.md between the PODMAN-HOST-ROWS markers:\n");
console.log("| Row | Result | Podman | Date |\n|---|---|---|---|");
for (const { row, result, needs } of ROWS) {
	const mine = checks.filter((c) => needs.test(c.id));
	if (mine.length > 0 && mine.every((c) => c.ok)) console.log(`| ${row} | ${result} | ${podmanVersion} | ${today} |`);
}
const held = ROWS.filter(({ needs }) => checks.some((c) => needs.test(c.id)) && checks.filter((c) => needs.test(c.id)).every((c) => c.ok)).length;
console.log(`\n${held} of ${ROWS.length} rows held; ${failed.length} check(s) failed${failed.length > 0 ? `: ${failed.map((c) => c.id).join(", ")}` : ""}`);
process.exit(failed.length > 0 ? 1 : 0);
