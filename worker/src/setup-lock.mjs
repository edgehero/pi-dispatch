/** One filesystem lock for every setup mutation of a deployment, including private viewer writes. */
import * as nodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** Canonical, account-owned directory incarnation bound to a setup grant. */
export function setupDeploymentIdentity(deployment, { fs = nodeFs, uid = process.geteuid?.() } = {}) {
	try {
		const dir = fs.realpathSync(deployment);
		const st = fs.statSync(dir);
		if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022)) return null;
		for (let parent = dirname(dir); ; parent = dirname(parent)) {
			const ancestor = fs.statSync(parent);
			if (!ancestor.isDirectory() || (ancestor.uid !== uid && ancestor.uid !== 0) || ((ancestor.mode & 0o022) && !(ancestor.mode & 0o1000))) return null;
			if (parent === dirname(parent)) break;
		}
		return { path: dir, uid: st.uid, dev: st.dev, ino: st.ino };
	} catch { return null; }
}

export function acquireSetupLock(deployment, { fs = nodeFs, uid = process.geteuid?.(), random = randomBytes, pid = process.pid } = {}) {
	const identity = setupDeploymentIdentity(deployment, { fs, uid });
	if (!identity) return { refusal: "unsafe-deployment" };
	const path = join(identity.path, ".pi-dispatch-setup.lock");
	const text = `${pid}:${random(16).toString("hex")}`;
	try { fs.writeFileSync(path, text, { flag: "wx", mode: 0o600 }); }
	catch { return { refusal: "setup-busy" }; }
	// A dead process does not prove the file still belongs to that process: two reap callers
	// could unlink a new winner's lock. Leave crash recovery to a host operator instead.
	return { release() {
		let fd;
		try {
			fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK);
			const opened = fs.fstatSync(fd);
			if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o077) || fs.readFileSync(fd, "utf8") !== text) return;
			const current = fs.lstatSync(path);
			if (!current.isSymbolicLink() && current.ino === opened.ino && current.dev === opened.dev) fs.unlinkSync(path);
		} catch { /* A removed/replaced lock is not ours to release. */ }
		finally { if (fd !== undefined) fs.closeSync(fd); }
	} };
}
