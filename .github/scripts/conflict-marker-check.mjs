/**
 * No tracked text file may carry a merge-conflict marker (issue #446's gate, PR #457).
 *
 * THE FAILURE THIS EXISTS FOR merged once already in spirit: a rebase left `<<<<<<< HEAD`, `=======` and `>>>>>>> ...`
 * in `specs/requirements.md`'s revision table, and every guard was green. `revision-row-check.mjs` skips lines that
 * are not table rows, the suite never reads a spec's history, and the markers render on the page as plain text. So
 * this looks for the markers themselves, in EVERY tracked text file (`git ls-files`; gate round 3 widened it from a
 * list of directories, which a new top-level file or directory would have silently escaped).
 *
 * WHAT A MARKER IS, exactly git's: a line starting `<<<<<<< ` or `>>>>>>> ` (seven characters and a space), or a line
 * that is exactly `=======`. The last is also a legal setext heading underline for a seven-character title, which
 * no file here uses; a future one would be told here and can use `#` instead.
 *
 * Binary files (a NUL in the first 8 KiB) are skipped. `findConflictMarkers` is exported so its test pins the rule
 * on constructed text rather than on this repository's current contents.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OPEN = "<".repeat(7);
const MIDDLE = "=".repeat(7);
const CLOSE = ">".repeat(7);

/** The 1-based line numbers of `text` that are conflict markers. */
export function findConflictMarkers(text) {
	const out = [];
	String(text ?? "")
		.split("\n")
		.forEach((raw, i) => {
			const line = raw.replace(/\r$/, "");
			if (line.startsWith(`${OPEN} `) || line.startsWith(`${CLOSE} `) || line === OPEN || line === CLOSE || line === MIDDLE) out.push(i + 1);
		});
	return out;
}

/** Every finding in `root`'s tracked text files, as `path:line`. */
export function scan(root) {
	const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
	const findings = [];
	for (const file of files) {
		let buf;
		try {
			buf = readFileSync(`${root}/${file}`);
		} catch {
			continue; // deleted in the working tree
		}
		if (buf.subarray(0, 8192).includes(0)) continue;
		for (const line of findConflictMarkers(buf.toString("utf8"))) findings.push(`${file}:${line}`);
	}
	return { files: files.length, findings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const root = fileURLToPath(new URL("../..", import.meta.url));
	const { files, findings } = scan(root);
	if (findings.length > 0) {
		process.stderr.write(`conflict-marker-check: ${findings.length} merge-conflict marker line(s):\n${findings.map((f) => `  ${f}\n`).join("")}\nResolve the merge: keep the lines you mean and delete the marker lines.\n`);
		process.exit(1);
	}
	process.stdout.write(`conflict-marker-check: ${files} tracked files, no merge-conflict marker\n`);
}
