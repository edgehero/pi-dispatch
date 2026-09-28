// A port of systemd v259's EnvironmentFile= parser (src/basic/env-file.c, parse_env_file_internal and
// load_env_file_push), for tests only: the venue keys a unit would see from a `.env` TEXT. It is an ORACLE only because
// a test pins it to every row of `systemd-env-259.mjs`, which is what systemd 259 set, measured; a port nobody checks
// against the real thing is a second opinion, not an oracle. Issue #447, gate round 1 (after the port the diff
// reviewer fuzzed the reader with).
//
// Not modelled: invalid UTF-8, which needs bytes (`envFileLoadHazard` and its measured rows cover it). A NUL anywhere
// is modelled, as the load failure it is.
const NEWLINE = "\n\r";
const WHITESPACE = " \t\n\r";
const COMMENTS = "#;";
const SHELL_NEED_ESCAPE = '"\\`$';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function systemdEnvFile(text) {
	if (text.includes("\0")) return { loads: false, env: {} };
	const env = {};
	let state = "PRE_KEY";
	let key = "";
	let value = null;
	let lastKeyWhitespace = -1;
	let lastValueWhitespace = -1;
	const add = (c) => {
		value = (value ?? "") + c;
	};
	const push = () => {
		const k = lastKeyWhitespace === -1 ? key : key.slice(0, lastKeyWhitespace);
		// systemd pushes every key and drops an invalid NAME when it builds the environment, which is the same result.
		if (NAME.test(k)) env[k] = value ?? "";
		key = "";
		value = null;
	};
	const trimValue = () => {
		if (value !== null && lastValueWhitespace !== -1) value = value.slice(0, lastValueWhitespace);
	};
	for (const c of text) {
		switch (state) {
			case "PRE_KEY":
				if (COMMENTS.includes(c)) state = "COMMENT";
				else if (!WHITESPACE.includes(c)) {
					state = "KEY";
					lastKeyWhitespace = -1;
					key += c;
				}
				break;
			case "KEY":
				if (NEWLINE.includes(c)) {
					state = "PRE_KEY";
					key = "";
				} else if (c === "=") {
					state = "PRE_VALUE";
					lastValueWhitespace = -1;
				} else {
					if (!WHITESPACE.includes(c)) lastKeyWhitespace = -1;
					else if (lastKeyWhitespace === -1) lastKeyWhitespace = key.length;
					key += c;
				}
				break;
			case "PRE_VALUE":
				if (NEWLINE.includes(c)) {
					state = "PRE_KEY";
					push();
				} else if (c === "'") state = "SINGLE_QUOTE_VALUE";
				else if (c === '"') state = "DOUBLE_QUOTE_VALUE";
				else if (c === "\\") state = "VALUE_ESCAPE";
				else if (!WHITESPACE.includes(c)) {
					state = "VALUE";
					add(c);
				}
				break;
			case "VALUE":
				if (NEWLINE.includes(c)) {
					state = "PRE_KEY";
					trimValue();
					push();
				} else if (c === "\\") {
					state = "VALUE_ESCAPE";
					lastValueWhitespace = -1;
				} else {
					if (!WHITESPACE.includes(c)) lastValueWhitespace = -1;
					else if (lastValueWhitespace === -1) lastValueWhitespace = (value ?? "").length;
					add(c);
				}
				break;
			case "VALUE_ESCAPE":
				state = "VALUE";
				if (!NEWLINE.includes(c)) add(c);
				break;
			case "SINGLE_QUOTE_VALUE":
				if (c === "'") state = "PRE_VALUE";
				else add(c);
				break;
			case "DOUBLE_QUOTE_VALUE":
				if (c === '"') state = "PRE_VALUE";
				else if (c === "\\") state = "DOUBLE_QUOTE_VALUE_ESCAPE";
				else add(c);
				break;
			case "DOUBLE_QUOTE_VALUE_ESCAPE":
				state = "DOUBLE_QUOTE_VALUE";
				if (SHELL_NEED_ESCAPE.includes(c)) add(c);
				else if (c !== "\n") {
					add("\\");
					add(c);
				}
				break;
			case "COMMENT":
				if (c === "\\") state = "COMMENT_ESCAPE";
				else if (NEWLINE.includes(c)) state = "PRE_KEY";
				break;
			case "COMMENT_ESCAPE":
				state = NEWLINE.includes(c) ? "PRE_KEY" : "COMMENT";
				break;
		}
	}
	if (["PRE_VALUE", "VALUE", "VALUE_ESCAPE", "SINGLE_QUOTE_VALUE", "DOUBLE_QUOTE_VALUE", "DOUBLE_QUOTE_VALUE_ESCAPE"].includes(state)) {
		if (state === "VALUE") trimValue();
		push();
	}
	return { loads: true, env };
}
