/**
 * Find a duplicate key in JSON text (issue #313).
 *
 * `JSON.parse` accepts a duplicate key and silently keeps the LAST value, so
 * `{"run":{"flow":"safe","flow":"evil"}}` parses to `evil` while a reviewer reading the file top to bottom
 * sees `safe`. For `triggers.json` that is not a curiosity: this project's whole authorisation story rests
 * on that file being the reviewed artifact. `DES-PER-TRIGGER-SECRET-PROFILE` says the overlay is not the
 * reviewed artifact and the file is, the secrets refusals name it, and `CONST-TRIGGER-AUTHOR-GATE` treats
 * a merged change to it as the gate. A field whose reviewed value and effective value differ defeats the
 * review rather than the runtime, and the reach is the whole schema: `run.flow`, `run.command`, `on.type`,
 * a scoped limit, a `run.secrets` reference. Any of them can be written twice.
 *
 * WHY A TEXT SCAN AND NOT A REVIVER. `JSON.parse`'s reviver sees each key with the value already resolved,
 * so it is called ONCE for a duplicated key, with the winning value: it cannot tell a duplicate from a
 * single occurrence. Node 22's third `context` argument gives the source text of that one value and no
 * more. Measured both ways. Catching this needs the raw text, which every caller already holds.
 *
 * WHY THIS IS SAFE TO HAND-WRITE, which is the real question, because a hand-written source-text parser is
 * a trap this project has already fallen into once (issue #282, four rounds of latent defects in a comment
 * stripper). Two things make this one different.
 *
 * FIRST, IT RUNS ONLY ON TEXT `JSON.parse` HAS ALREADY ACCEPTED. Every caller parses first and scans
 * second. So the scanner never has to decide whether malformed input is malformed, never has to recover
 * from anything, and every branch it does not have is a branch that cannot be wrong. Feeding it text that
 * did not parse is a caller error, not an input case: the result is unspecified rather than a refusal.
 *
 * SECOND, IT IS CHECKED AGAINST A GENERATOR THAT KNOWS THE ANSWER. `worker/test/json-duplicates.test.mjs`
 * builds thousands of documents with adversarial key characters -- quotes, backslashes, newlines, braces,
 * colons, non-ASCII -- injects a duplicate at a known path in half of them, and requires the scanner to
 * agree exactly. That is an oracle rather than a restatement, which is what the #282 lesson asks for.
 *
 * KEYS ARE COMPARED DECODED, not byte by byte, and that is the case an attacker would actually use:
 * a key written plainly and the same key written with a `u00`-style escape are ONE key to `JSON.parse`,
 * and a byte comparison sees two.
 *
 * IMPORT-FREE, like `reserved-env.mjs` and `provider-key.mjs` beside it: `triggers.mjs` is the shared
 * validator, the receiver loads it and `admin/build.mjs` inlines it into the published console, so
 * anything it reaches has to be as cheap as a list of strings.
 */

/** The escape characters JSON defines, other than `\u`. */
const SIMPLE_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * The first duplicate key in `text`, as `{ key, at }`, or `null` when there is none.
 *
 * `at` is a dotted path through the enclosing keys and array indices (`triggers.2.run.flow`), because the
 * key alone is not enough to find it: `flow` appears in every entry, and the whole point of the refusal is
 * that the operator can go and look at the one that lies.
 *
 * The separator is NOT escaped, so a key containing a dot, or an object key that is a number, produces a
 * path that reads like a different shape. That is a signpost rather than an address, and it is left
 * unescaped deliberately: for this schema it is unreachable (every schema key is a fixed identifier, and
 * `run.secrets` keys are gated by `ENV_NAME`), and quoting the segments would make the common case harder
 * to read to fix a case the file cannot contain.
 */
export function findDuplicateKey(text) {
	const s = String(text);
	const n = s.length;
	let i = 0;
	// One frame per open container. `keys` is a Set for an object and null for an array, which is also how
	// the reader knows whether a string in value position is a key.
	const stack = [];
	// The path to the value currently being read, as keys and array indices.
	const path = [];

	const skipWhitespace = () => {
		while (i < n) {
			const c = s.charCodeAt(i);
			if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
			else break;
		}
	};

	/**
	 * Walk past the string starting at `s[i] === '"'` WITHOUT building it.
	 *
	 * Value position only, and it is not a micro-optimisation: `readString` accumulates about 32 bytes of
	 * heap per source character, so a single 64MB string value cost 2GB of garbage to decode a value this
	 * function then discards. A trigger's `run.task` and `run.instructions` are free text, and a worker
	 * that dies at boot reading its own configuration is a worse failure than anything this file refuses.
	 */
	const skipString = () => {
		i++; // the opening quote
		while (i < n) {
			const ch = s[i];
			if (ch === '"') {
				i++;
				return;
			}
			// An escape consumes its own next character, which is what stops `\"` ending the string. The
			// `\uXXXX` digits need no special case here: none of them is a quote or a backslash.
			i += ch === "\\" ? 2 : 1;
		}
	};

	/** Read the string starting at `s[i] === '"'` and return its DECODED value. Keys only. */
	const readString = () => {
		i++; // the opening quote
		let out = "";
		while (i < n) {
			const ch = s[i];
			if (ch === '"') {
				i++;
				return out;
			}
			if (ch === "\\") {
				const esc = s[i + 1];
				i += 2;
				if (esc === "u") {
					// A lone surrogate is preserved as itself, which is what JSON.parse does too, so a pair
					// written as two escapes still compares equal to the same pair written literally.
					out += String.fromCharCode(Number.parseInt(s.slice(i, i + 4), 16));
					i += 4;
				} else {
					out += SIMPLE_ESCAPES[esc] ?? esc;
				}
				continue;
			}
			out += ch;
			i++;
		}
		return out; // unreachable on text that parsed
	};

	// True when the next string is a KEY rather than a value: just after `{`, or after a `,` inside one.
	let expectKey = false;

	while (i < n) {
		skipWhitespace();
		if (i >= n) break;
		const ch = s[i];

		if (ch === "{") {
			stack.push({ keys: new Set(), named: false });
			expectKey = true;
			i++;
			continue;
		}
		if (ch === "[") {
			stack.push({ keys: null, named: false });
			path.push(0);
			expectKey = false;
			i++;
			continue;
		}
		if (ch === "}" || ch === "]") {
			const frame = stack.pop();
			// An array frame owns its index; an object frame owns the key of the member it is inside.
			if (frame && (frame.keys === null || frame.named)) path.pop();
			expectKey = false;
			i++;
			continue;
		}
		if (ch === ",") {
			const top = stack[stack.length - 1];
			if (top && top.keys === null) {
				path[path.length - 1] = (path[path.length - 1] ?? 0) + 1;
				expectKey = false;
			} else if (top) {
				if (top.named) {
					path.pop();
					top.named = false;
				}
				expectKey = true;
			}
			i++;
			continue;
		}
		if (ch === ":") {
			// Nothing to do but step over it. `expectKey` was already cleared where the key was read, so an
			// assignment here would be unreachable state: on text that parsed, a `:` can only follow a key.
			// (It was written that way first, and a mutation check found it pinned nothing.)
			i++;
			continue;
		}
		if (ch === '"') {
			const top = stack[stack.length - 1];
			if (expectKey && top && top.keys !== null) {
				const key = readString();
				if (top.keys.has(key)) return { key, at: [...path, key].join(".") };
				top.keys.add(key);
				path.push(key);
				top.named = true;
				expectKey = false;
				continue;
			}
			skipString();
			continue;
		}
		// A bare literal: a number, `true`, `false` or `null`. Nothing inside one can be a key or a quote,
		// so it is enough to run to the next structural character.
		//
		// This loop is an OPTIMISATION, not a rule: stepping one character at a time would re-enter the
		// switch and land back here until the same structural character, so the two are behaviourally
		// identical (checked over 15000 documents). No test can distinguish them, which is worth saying
		// here so the next mutation check reads it as equivalent rather than as a hole.
		while (i < n && !STRUCTURAL.has(s[i])) i++;
	}
	return null;
}

/** Characters that end a bare literal. */
const STRUCTURAL = new Set([",", ":", "{", "}", "[", "]", '"', " ", "\t", "\n", "\r"]);
