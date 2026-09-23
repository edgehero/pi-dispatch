/**
 * Every row of a spec's revision table must render as exactly TWO cells (issue #388).
 *
 * THE FAILURE THIS EXISTS FOR IS INVISIBLE IN A DIFF. A revision row is one markdown table row, and the
 * table declares two columns. An unescaped `|` inside the Change cell ends that cell, and GitHub discards
 * every cell after the second -- so the rest of the row is simply not rendered. The diff looks right, the
 * review reads right, and the rendered page silently loses the paragraph. Four rows across three files had
 * lost between 1,100 and 2,800 characters each, including most of a `CONST-TRIGGER-AUTHOR-GATE`
 * amendment, and nothing in CI looked at these tables at all.
 *
 * WHY THIS IS A BOLT AND NOT A REVIEW HABIT. `CLAUDE.md`'s rule is that a hand-written table restating a
 * derivable source is either derived or pinned. This is the narrow, mechanical half of that: the number of
 * cells in a row is derivable from the row, needs no prose understanding, and is the one thing in a
 * revision row that a human reader cannot see by reading the diff. The three other guards in this directory
 * each earn their place the same way -- a class that had bitten, checkable without parsing meaning.
 *
 * WHAT IT DOES NOT CHECK, stated rather than implied. It says nothing about whether a row is TRUE, whether
 * it is in the right file, or whether it was appended at the right end (`requirements.md` and
 * `constitution.md` prepend; the other three append). Those are review's job. It also does not look at
 * tables outside the revision history: a two-column rule is this table's, not markdown's.
 *
 * WHERE THE TABLE STARTS. The LAST header row in the file whose first cell is `Date` or `Version`. Today
 * that is also the ONLY one in each of the five files -- checked, rather than asserted as the reason -- and
 * "last" is what keeps it right if a body table with those headings is added later. Rows before it are
 * other tables and are not this guard's business.
 *
 * ROWS WITHOUT BOTH OUTER PIPES ARE NOT CHECKED, and that is a stated hole rather than an oversight. GFM
 * makes the leading and trailing pipe optional, so `2026-01-01 | ...` is a legal row that this guard skips
 * and that CAN be truncated. Every row in these five files has both, the repo writes them that way, and
 * recognising the optional forms means deciding which lines in a markdown file are table rows at all --
 * which is the arms race `CLAUDE.md` warns about. A row that loses an outer pipe is caught by reading the
 * diff, unlike the class this exists for.
 *
 * ESCAPING. `\|` inside a code span renders as a literal pipe and keeps the cell, which two rows in
 * `design.md` already did correctly before this guard existed, so the convention is the repo's own rather
 * than one imported with the check. Where the pipes separate a list rather than spelling a command, prose
 * reads better than escaping: "worker, receiver, admin".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILES = ["constitution.md", "requirements.md", "design.md", "interfaces.md", "open-questions.md"].map((name) =>
	fileURLToPath(new URL(`../../specs/${name}`, import.meta.url)),
);

/** A pipe that is not escaped as `\|`, which is the one that ends a cell. */
const UNESCAPED_PIPE = /(?<!\\)\|/g;

/** The header of a revision table: `| Date | Change |` or `| Version | ... |`. */
const REVISION_HEADER = /^\|\s*(Date|Version)\s*\|/;

const findings = [];
let rowCount = 0;

for (const file of FILES) {
	const lines = readFileSync(file, "utf8").split("\n");
	// The LAST such header: these files carry other Date-headed tables in their body.
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (REVISION_HEADER.test(lines[i])) start = i;
	}
	if (start === -1) {
		findings.push(`${file}: no revision table header found, so this guard is watching nothing here`);
		continue;
	}
	// `start + 2` skips the header and its `|---|` delimiter, which are not revision rows and would inflate
	// the count this prints by two per file.
	for (let i = start + 2; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith("|") || !line.trimEnd().endsWith("|")) continue;
		// The outer pipes contribute one empty part each, so cells = parts - 2.
		const pipes = [...line.matchAll(UNESCAPED_PIPE)];
		const cells = pipes.length - 1;
		rowCount++;
		if (cells !== 2) {
			// The THIRD pipe is where the row is cut. A row with FEWER than two cells has none, so the
			// message says where it ends instead of dereferencing a pipe that is not there.
			const at = pipes[2];
			const where = at
				? `the row is cut after "...${line.slice(Math.max(0, at.index - 40), at.index)}"`
				: `the row ends after "...${line.slice(Math.max(0, line.length - 40))}"`;
			findings.push(`${file}:${i + 1}: ${cells} cells, expected 2 -- ${where}`);
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(
		`revision-row-check: ${findings.length} revision row(s) render with the wrong number of cells:\n` +
			findings.map((f) => `  ${f}\n`).join("") +
			"\nA revision table has TWO columns, so an unescaped `|` ends the Change cell and GitHub drops the rest\n" +
			"of the row. Escape it as `\\|` (which renders as a pipe, including inside a code span), or rewrite the\n" +
			"list as prose where the pipes were separating one (issue #388).\n",
	);
	process.exit(1);
}

process.stdout.write(`revision-row-check: ${rowCount} revision rows across ${FILES.length} spec files, every one renders as two cells\n`);
