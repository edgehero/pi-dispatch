/**
 * "Is this module the program node was asked to run?" (issue #489), for every bin and entry file.
 *
 * The old guard compared `import.meta.url` with `file://${process.argv[1]}`, or tested that argv[1] ended in the
 * file's own name. Neither holds through npm's bin link: npm installs `.bin/pi-dispatch` as a SYMLINK to
 * `src/cli.mjs`, node puts the link's own path in argv[1] and the resolved path in `import.meta.url`, and the
 * link's name ends in `pi-dispatch`, not `cli.mjs`. So `npx @edgehero/pi-dispatch init`, a local `.bin` and a
 * global install all exited 0 having run nothing, while `node .../src/cli.mjs` (how `/dispatch setup` and the
 * rendered service units call it) worked, which is why nothing that ships noticed.
 *
 * The rule is the one question underneath both old tests: do argv[1] and this module name the same FILE once
 * links are resolved. `realpathSync` resolves the link, and both sides go through that same call, so a
 * spelling it keeps (a case difference, say) is kept on both; `fileURLToPath` turns the module URL into a path on every
 * platform, where string concatenation produced `file://C:\...`.
 * A missing or unreadable argv[1] (node -e, the REPL, a test runner) is simply "not the entry".
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isEntryModule(moduleUrl, { argv1 = process.argv[1], realpath = realpathSync } = {}) {
	if (typeof argv1 !== "string" || argv1 === "") return false;
	try {
		return realpath(argv1) === realpath(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}
