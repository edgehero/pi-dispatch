// Issue #645: a preload (`node --import`) that lets the REAL run-job.mjs run outside a container. The runner's paths
// are absolute container mounts (/job, /workspace, /session, /outbox, /inbox, /opt/pi-global, /opt/pi-dispatch) and it has no
// seam for them, by design: they are the container contract. This moves each of those roots under the directory named
// by PI_DISPATCH_TEST_ROOT, for every fs call of the process (sync, callback and promise forms, the ES named imports
// included through syncBuiltinESMExports) and a spawned child's cwd. Everything else is the runner's own code path.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const ROOT = process.env.PI_DISPATCH_TEST_ROOT;
// Issue #888: with PI_DISPATCH_TEST_HIDE_PROBES=1 the activity watch's CPU and network probes read under the test root too,
// where nothing is, so they read as unreadable. Outside a container the cgroup is the whole test session's, and a busy
// test machine would read as a busy job. Test-only: this preload is the fixture's, and the runner never reads the name.
const PROBES = process.env.PI_DISPATCH_TEST_HIDE_PROBES === "1" ? ["/sys/fs/cgroup", "/proc/net/dev", "/proc/self/cgroup"] : [];
const MOUNTS = ["/job", "/workspace", "/session", "/outbox", "/inbox", "/opt/pi-global", "/opt/pi-dispatch", ...PROBES];

const remap = (path) => {
	const text = path instanceof URL ? (path.protocol === "file:" ? path.pathname : null) : typeof path === "string" ? path : null;
	if (text === null) return path;
	for (const mount of MOUNTS) if (text === mount || text.startsWith(`${mount}/`)) return `${ROOT}${text}`;
	return path;
};

const ONE_PATH = ["access", "appendFile", "chmod", "chown", "createReadStream", "createWriteStream", "exists", "lchown", "lstat", "mkdir", "mkdtemp", "open", "opendir", "readdir", "readFile", "readlink", "realpath", "rm", "rmdir", "stat", "statfs", "truncate", "unlink", "utimes", "watch", "watchFile", "writeFile"];
const TWO_PATHS = ["copyFile", "cp", "link", "rename", "symlink"];

function wrap(owner, name, both) {
	const real = owner[name];
	if (typeof real !== "function") return;
	const wrapped = Object.assign(function (first, second, ...rest) {
		return real.call(this, remap(first), both ? remap(second) : second, ...rest);
	}, real);
	owner[name] = wrapped;
}
for (const name of ONE_PATH) {
	wrap(fs, name, false);
	wrap(fs, `${name}Sync`, false);
	wrap(fs.promises, name, false);
}
for (const name of TWO_PATHS) {
	wrap(fs, name, true);
	wrap(fs, `${name}Sync`, true);
	wrap(fs.promises, name, true);
}
// realpathSync.native is a property of the original; keep it, remapped.
const realNative = fs.realpathSync.native;
if (typeof realNative === "function") fs.realpathSync.native = (path, ...rest) => realNative(remap(path), ...rest);

for (const name of ["spawn", "execFile", "exec", "fork"]) {
	const real = childProcess[name];
	childProcess[name] = function (...args) {
		const options = args.find((arg, i) => i > 0 && arg !== null && typeof arg === "object" && !Array.isArray(arg));
		if (options && typeof options.cwd === "string") options.cwd = remap(options.cwd);
		return real.apply(this, args);
	};
}
// Issue #946: with PI_DISPATCH_TEST_OWN_PROC=1 a listing of /proc names only this process's own descendants, as the job's
// pid namespace does in a container. Outside one, on a Linux host, the runner's child detector (child-watch.mjs
// `linuxProc`) reads every process of the machine, and a test suite runs several jobs at once: another test's runner or
// role child, which carries another job's ledger directory, was read as this job's unmetered child and stopped it under
// its model list (seen on CI). Every process this runner starts is still listed, so a pi process the job itself starts
// is judged as it is in a container; one that leaves the tree (its parent gone, taken in by pid 1) is not, which only a
// container run shows. Test-only, opt-in, and Linux-only: elsewhere there is no /proc and no detector.
if (process.env.PI_DISPATCH_TEST_OWN_PROC === "1" && process.platform === "linux") {
	const readdir = fs.readdirSync;
	const readFile = fs.readFileSync;
	const parentOf = (pid) => {
		try {
			const text = readFile(`/proc/${pid}/stat`, "latin1");
			return Number(text.slice(text.lastIndexOf(")") + 2).split(" ")[1]);
		} catch {
			return 0;
		}
	};
	const ours = (pid) => {
		for (let at = Number(pid), steps = 0; at > 1 && steps < 64; steps += 1) {
			if (at === process.pid) return true;
			at = parentOf(at);
		}
		return false;
	};
	fs.readdirSync = Object.assign(function (path, ...rest) {
		const names = readdir.call(this, path, ...rest);
		return path === "/proc" && rest.length === 0 ? names.filter((name) => !/^[1-9][0-9]*$/.test(String(name)) || ours(name)) : names;
	}, readdir);
}
syncBuiltinESMExports();
