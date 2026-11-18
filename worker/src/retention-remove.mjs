import * as nodeFs from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Committed deletions, excluded from session/fork key vocabularies. A restart retries only this exact shape. */
export const RETENTION_TOMBSTONE_RE = /^\.retired-[0-9]+-[0-9]+-[0-9]+$/;

/** Detach while the caller still owns its synchronous expiry decision; deletion may then safely yield. */
export function makeRetentionRemover({ fs = nodeFs, remove = rm, now = Date.now, pid = process.pid } = {}) {
	let seq = 0;
	return {
		detach(path) {
			const tomb = join(dirname(path), `.retired-${pid}-${now()}-${seq++}`);
			fs.renameSync(path, tomb);
			return tomb;
		},
		remove: (path) => remove(path, { recursive: true, force: true }),
		async leftovers(root, { stopped = () => false } = {}) {
			for (const name of fs.readdirSync(root)) {
				if (stopped()) return;
				if (RETENTION_TOMBSTONE_RE.test(name)) await remove(join(root, name), { recursive: true, force: true });
			}
		},
	};
}
