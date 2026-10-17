// Issue #645: a preload (`node --import`) that lets the REAL run-job.mjs run outside a container. The runner's paths
// are absolute container mounts (/job, /workspace, /session, /outbox, /inbox, /opt/pi-global, /opt/pi-dispatch) and it has no
// seam for them, by design: they are the container contract. This moves each of those roots under the directory named
// by PI_DISPATCH_TEST_ROOT, for every fs call of the process (sync, callback and promise forms, the ES named imports
// included through syncBuiltinESMExports) and a spawned child's cwd. Everything else is the runner's own code path.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const ROOT = process.env.PI_DISPATCH_TEST_ROOT;
const MOUNTS = ["/job", "/workspace", "/session", "/outbox", "/inbox", "/opt/pi-global", "/opt/pi-dispatch"];

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
syncBuiltinESMExports();
