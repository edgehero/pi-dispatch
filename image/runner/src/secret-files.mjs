import * as nodeFs from "node:fs";
import { LAYOUT } from "./layout.mjs";
import { configError } from "./outcome.mjs";

export const SECRET_FILES_FLAG = "PI_SECRET_FILES";
export const SECRET_FILE_MAX_BYTES = 64 * 1024;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Verify the worker's grant before any tool can read it. A wrong mount must fail before the model spends. */
export function verifySecretFiles({ env = process.env, directory = LAYOUT.secretFiles, fs = nodeFs, uid = process.geteuid?.() } = {}) {
	// env-internal PI_SECRET_FILES: the worker's names, never a value or a caller-selected path.
	const flag = env.PI_SECRET_FILES;
	delete env.PI_SECRET_FILES;
	if (flag === undefined) return 0;
	const names = typeof flag === "string" ? flag.split(",") : [];
	const folded = new Set(names.map((name) => name.toLowerCase()));
	const fail = () => { throw configError("the job's secret files are missing, unreadable, or have an unsafe owner, path or mode", "secret-files-unusable"); };
	if (names.length === 0 || names.length > 80 || folded.size !== names.length || names.some((name) => !NAME.test(name) || DEVICE_NAME.test(name) || name === "__proto__")) fail();
	try {
		const parent = fs.lstatSync(directory);
		if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || parent.uid !== uid) fail();
		for (const name of names) {
			const path = `${directory}/${name}`;
			if (env[name] !== path) fail();
			const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				const st = fs.fstatSync(fd);
				if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size < 1 || st.size > SECRET_FILE_MAX_BYTES) fail();
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch { fail(); }
	return names.length;
}
