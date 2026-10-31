import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	TOKEN_NAME_RE,
	TOKEN_PREFIX,
	TOKEN_ROLES,
	addToken,
	endAllSessions,
	findToken,
	hashToken,
	newToken,
	operatorCount,
	parseTokensFile,
	readTokensFile,
	revokeToken,
	rotateToken,
	tokensFilePath,
	tokensFileProblem,
} from "../src/console-tokens.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The console's tokens file (issue #640). Real files in a temp dir: the mode, owner and symlink refusals are about what
// the kernel reports, so a fake fs would only test the fake. Windows has no mode bits or uids to judge.
const posix = process.platform !== "win32";
const uid = posix ? process.getuid() : null;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const now = () => NOW;

/** A deterministic random source: each call returns the next byte value repeated, so every token differs. */
function counter(start = 1) {
	let n = start;
	return (size) => Buffer.alloc(size, n++);
}

const H = (c) => c.repeat(64);
function fileText(tokens, extra = {}) {
	return JSON.stringify({ version: 1, generation: 0, tokens, ...extra });
}
function entry(name, role = "operator", sha256 = H("a")) {
	return { name, role, sha256, createdAt: "2026-10-01T00:00:00.000Z" };
}
function writePrivate(path, text) {
	fs.writeFileSync(path, text, { mode: 0o600 });
	fs.chmodSync(path, 0o600);
}

test("newToken is the prefix plus 32 random bytes as base64url, and hashToken is SHA-256 hex", () => {
	const token = newToken(() => Buffer.alloc(32, 7));
	assert.equal(token, `${TOKEN_PREFIX}${Buffer.alloc(32, 7).toString("base64url")}`);
	assert.equal(token.length, 4 + 43);
	assert.match(newToken(), /^pdc_[A-Za-z0-9_-]{43}$/);
	assert.equal(hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	assert.deepEqual([...TOKEN_ROLES], ["operator", "viewer", "agent"]);
	assert.ok(TOKEN_NAME_RE.test("ops.rob-1") && !TOKEN_NAME_RE.test("-x") && !TOKEN_NAME_RE.test("A") && !TOKEN_NAME_RE.test("a".repeat(33)));
});

test("tokensFilePath resolves PI_CONSOLE_TOKENS_FILE, or console-tokens.json, against the deployment dir", () => {
	assert.equal(tokensFilePath({}, "/srv/dep"), "/srv/dep/console-tokens.json");
	assert.equal(tokensFilePath({ PI_CONSOLE_TOKENS_FILE: "  " }, "/srv/dep"), "/srv/dep/console-tokens.json");
	assert.equal(tokensFilePath({ PI_CONSOLE_TOKENS_FILE: "state/t.json" }, "/srv/dep"), "/srv/dep/state/t.json");
	assert.equal(tokensFilePath({ PI_CONSOLE_TOKENS_FILE: "/etc/pd/t.json" }, "/srv/dep"), "/etc/pd/t.json");
});

test("parseTokensFile accepts the v1 shape, reduces entries to four fields, and reads a missing generation as 0", () => {
	const parsed = parseTokensFile(JSON.stringify({ version: 1, tokens: [{ ...entry("rob"), extra: 1 }, entry("view", "viewer", H("b"))] }), "/t.json");
	assert.equal(parsed.version, 1);
	assert.equal(parsed.generation, 0);
	assert.deepEqual(parsed.tokens[0], entry("rob"));
	assert.equal(parsed.tokens[1].role, "viewer");
	assert.equal(parseTokensFile(fileText([], { generation: 7 }), "/t.json").generation, 7);
});

test("parseTokensFile refuses every malformed file with a sentence naming the path, and never quotes a hash", () => {
	const cases = [
		["{", /not valid JSON/],
		["[]", /must hold a JSON object/],
		[JSON.stringify({ version: 2, tokens: [] }), /has version 2, and this pi-dispatch reads only version 1/],
		[JSON.stringify({ tokens: [] }), /has no version/],
		[fileText([], { generation: -1 }), /generation/],
		[fileText([], { generation: 1.5 }), /generation/],
		[JSON.stringify({ version: 1 }), /no "tokens" list/],
		[fileText([null]), /entry 1 .* is not an object/],
		[fileText([entry("Bad Name")]), /has a name that is not/],
		[fileText([entry("rob"), entry("rob", "viewer", H("b"))]), /entry 2 .* repeats the name "rob"/],
		[fileText([entry("rob", "admin")]), /role other than operator or viewer/],
		[fileText([entry("rob", "operator", "ABC")]), /sha256 that is not 64 lowercase hex/],
		[fileText([entry("rob", "operator", H("A"))]), /sha256 that is not 64 lowercase hex/],
		[fileText([entry("rob"), entry("ann", "viewer", H("a"))]), /same secret as another entry/],
		[fileText([{ ...entry("rob"), createdAt: "yesterday" }]), /createdAt that is not an ISO date/],
	];
	for (const [text, re] of cases) {
		assert.throws(() => parseTokensFile(text, "/dep/console-tokens.json"), (e) => {
			assert.match(e.message, re);
			assert.match(e.message, /\/dep\/console-tokens\.json/);
			assert.doesNotMatch(e.message, /a{64}|b{64}/);
			return true;
		}, text);
	}
});

test("tokensFileProblem: a missing file, a symlink, a directory, a group-readable mode and another owner are each refused", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	assert.match(tokensFileProblem({ path, uid }), /does not exist; create the first operator with `pi-dispatch-console token add/);

	writePrivate(path, fileText([entry("rob")]));
	assert.equal(tokensFileProblem({ path, uid }), null);
	assert.equal(tokensFileProblem({ path }), null, "the default owner is this process");

	fs.chmodSync(path, 0o644);
	assert.match(tokensFileProblem({ path, uid }), /can be read or written by other accounts \(mode 644\); run `chmod 600 /);
	fs.chmodSync(path, 0o640);
	assert.match(tokensFileProblem({ path, uid }), /mode 640/);
	fs.chmodSync(path, 0o602);
	assert.match(tokensFileProblem({ path, uid }), /mode 602/);
	fs.chmodSync(path, 0o600);

	assert.match(tokensFileProblem({ path, uid: uid + 1 }), new RegExp(`owned by uid ${uid}, not by this account \\(uid ${uid + 1}\\)`));
	assert.equal(tokensFileProblem({ path, uid: null }), null, "null skips the owner check (no uid on Windows)");

	const link = join(dir, "link.json");
	fs.symlinkSync(path, link);
	assert.match(tokensFileProblem({ path: link, uid }), /is a symbolic link, and the console reads only a regular file/);

	const sub = join(dir, "sub");
	fs.mkdirSync(sub, { mode: 0o700 });
	assert.match(tokensFileProblem({ path: sub, uid }), /is not a regular file/);
});

test("readTokensFile returns the parsed file, or the refusal of the problem check or of the parser", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	assert.match(readTokensFile({ path, uid }).refusal, /does not exist/);
	writePrivate(path, fileText([entry("rob")], { generation: 3 }));
	const { file } = readTokensFile({ path, uid });
	assert.equal(file.generation, 3);
	assert.equal(file.tokens[0].name, "rob");
	fs.chmodSync(path, 0o644);
	assert.match(readTokensFile({ path, uid }).refusal, /chmod 600/);
	writePrivate(path, JSON.stringify({ version: 9, tokens: [] }));
	assert.match(readTokensFile({ path, uid }).refusal, /version 9/);
	const link = join(dir, "l.json");
	fs.symlinkSync(path, link);
	assert.match(readTokensFile({ path: link, uid }).refusal, /symbolic link/);
});

test("readTokensFile judges the OPEN descriptor too: a file swapped for a link after the lstat is refused", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	const other = join(dir, "other.json");
	writePrivate(path, fileText([entry("rob")]));
	writePrivate(other, fileText([entry("evil")]));
	// The lstat sees the regular file; between it and the open, the name becomes a link.
	const racing = {
		...fs,
		lstatSync(p) {
			const st = fs.lstatSync(p);
			fs.rmSync(path);
			fs.symlinkSync(other, path);
			return st;
		},
	};
	const read = readTokensFile({ path, fs: racing, uid });
	assert.match(read.refusal, /symbolic link/);
	// And a mode change between the lstat and the open is caught by the fstat.
	fs.rmSync(path);
	writePrivate(path, fileText([entry("rob")]));
	const loosening = {
		...fs,
		lstatSync(p) {
			const st = fs.lstatSync(p);
			fs.chmodSync(path, 0o644);
			return st;
		},
	};
	assert.match(readTokensFile({ path, fs: loosening, uid }).refusal, /mode 644/);
});

test("findToken returns the right entry among several, null for an unknown or non-string token, and checks every entry", () => {
	const tokens = ["pdc_one", "pdc_two", "pdc_three"];
	const file = { version: 1, generation: 0, tokens: tokens.map((t, i) => entry(`n${i}`, i === 1 ? "viewer" : "operator", hashToken(t))) };
	assert.equal(findToken(file, "pdc_one").name, "n0");
	assert.equal(findToken(file, "pdc_two").name, "n1");
	assert.equal(findToken(file, "pdc_three").name, "n2");
	assert.equal(findToken(file, "pdc_four"), null);
	assert.equal(findToken(file, ""), null);
	assert.equal(findToken(file, undefined), null);
	assert.equal(findToken(file, 42), null);
	assert.equal(findToken(null, "pdc_one"), null);
	// A corrupt entry in memory compares as a zero digest and never throws or matches.
	assert.equal(findToken({ tokens: [{ name: "x", sha256: "zz" }, entry("ok", "operator", hashToken("pdc_ok"))] }, "pdc_ok").name, "ok");

	// No early exit: the digest of every entry is compared even when the first one matches.
	let reads = 0;
	const counting = tokens.map((t, i) => {
		const e = entry(`n${i}`, "operator", hashToken(t));
		return Object.defineProperty({ ...e }, "sha256", { get: () => (reads++, e.sha256), enumerable: true });
	});
	assert.equal(findToken({ tokens: counting }, "pdc_one").name, "n0");
	assert.ok(reads >= 3, `every entry was read (${reads})`);
});

test("operatorCount counts operator entries only", () => {
	assert.equal(operatorCount({ tokens: [entry("a"), entry("b", "viewer", H("b")), entry("c", "operator", H("c"))] }), 2);
	assert.equal(operatorCount({ tokens: [] }), 0);
	assert.equal(operatorCount(null), 0);
});

test("addToken creates the file at 0600, returns the plaintext once, and the stored hash finds it", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	const random = counter();
	const added = addToken({ path, name: "rob", role: "operator", now, random, uid });
	assert.match(added.token, /^pdc_[A-Za-z0-9_-]{43}$/);
	assert.deepEqual(added.entry, { name: "rob", role: "operator", sha256: hashToken(added.token), createdAt: new Date(NOW).toISOString() });
	assert.equal(fs.statSync(path).mode & 0o777, 0o600);
	const text = fs.readFileSync(path, "utf8");
	assert.doesNotMatch(text, new RegExp(added.token.slice(4)), "the plaintext is never stored");
	const { file } = readTokensFile({ path, uid });
	assert.deepEqual(file, { version: 1, generation: 0, tokens: [added.entry] });
	assert.equal(findToken(file, added.token).name, "rob");

	const viewer = addToken({ path, name: "view", role: "viewer", now, random, uid });
	assert.notEqual(viewer.token, added.token);
	assert.equal(readTokensFile({ path, uid }).file.tokens.length, 2);
	assert.deepEqual(fs.readdirSync(dir).sort(), ["console-tokens.json"], "no tmp file is left behind");
});

test("addToken refuses a bad name, a bad role, an existing name, a symlinked or loose file, and writes nothing", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	const random = counter();
	assert.match(addToken({ path, name: "Rob!", role: "operator", now, random, uid }).invalid, /a token name is 1 to 32 characters/);
	assert.match(addToken({ path, name: "rob", role: "root", now, random, uid }).invalid, /role is operator or viewer/);
	assert.equal(fs.existsSync(path), false);

	addToken({ path, name: "rob", role: "operator", now, random, uid });
	const before = fs.readFileSync(path, "utf8");
	assert.match(addToken({ path, name: "rob", role: "viewer", now, random, uid }).invalid, /a token named "rob" already exists; give it a new secret with `pi-dispatch-console token rotate --name rob`/);
	assert.equal(fs.readFileSync(path, "utf8"), before);

	fs.chmodSync(path, 0o644);
	assert.match(addToken({ path, name: "ann", role: "viewer", now, random, uid }).invalid, /chmod 600.*Nothing was written/);
	assert.equal(fs.readFileSync(path, "utf8"), before);
	fs.chmodSync(path, 0o600);

	assert.match(addToken({ path, name: "ann", role: "viewer", now, random, uid: uid + 1 }).invalid, /owned by uid/);

	const link = join(dir, "link.json");
	fs.symlinkSync(path, link);
	assert.match(addToken({ path: link, name: "ann", role: "viewer", now, random, uid }).invalid, /symbolic link/);
	assert.equal(fs.readFileSync(path, "utf8"), before);

	const dangling = join(dir, "dangling.json");
	fs.symlinkSync(join(dir, "nowhere.json"), dangling);
	assert.match(addToken({ path: dangling, name: "ann", role: "viewer", now, random, uid }).invalid, /symbolic link/);
	assert.equal(fs.existsSync(join(dir, "nowhere.json")), false, "a dangling link is never written through");

	assert.match(addToken({ path: join(dir, "missing-dir", "t.json"), name: "ann", role: "viewer", now, random, uid }).invalid, /could not be written \(ENOENT/);
	assert.deepEqual(fs.readdirSync(dir).sort(), ["console-tokens.json", "dangling.json", "link.json"]);
});

test("a write refuses when another writer changed the file after it was read, and leaves no tmp file", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	addToken({ path, name: "rob", role: "operator", now, random: counter(), uid });
	const racing = {
		...fs,
		chmodSync(p, m) {
			fs.chmodSync(p, m);
			if (p.endsWith(".tmp")) {
				const f = JSON.parse(fs.readFileSync(path, "utf8"));
				f.generation = 99;
				writePrivate(path, JSON.stringify(f));
			}
		},
	};
	assert.match(endAllSessions({ path, fs: racing, random: counter(50), uid }).invalid, /changed while this change was being made.*Run the command again/);
	assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).generation, 99, "the other writer's change stands");
	assert.deepEqual(fs.readdirSync(dir), ["console-tokens.json"]);
});

test("a write compares against the very text it parsed: another writer's change right after that read is refused, not lost", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	addToken({ path, name: "rob", role: "operator", now, random: counter(), uid });
	// The other command writes right after the judged read (through the descriptor) returns. A second read of the path
	// for `before` would see this write, and the stale `next` would then pass the pre-rename re-check and erase it.
	let raced = false;
	const racing = {
		...fs,
		readFileSync(p, ...rest) {
			const text = fs.readFileSync(p, ...rest);
			if (typeof p === "number" && !raced) {
				raced = true;
				const f = JSON.parse(text);
				f.tokens.push(entry("ann", "viewer", H("b")));
				writePrivate(path, JSON.stringify(f));
			}
			return text;
		},
	};
	assert.match(revokeToken({ path, name: "rob", fs: racing, random: counter(50), uid }).invalid, /changed while this change was being made/);
	assert.ok(raced, "the race ran");
	assert.deepEqual(readTokensFile({ path, uid }).file.tokens.map((t) => t.name), ["rob", "ann"], "the other writer's token stands, and rob was not revoked over it");
	assert.deepEqual(fs.readdirSync(dir), ["console-tokens.json"]);
});

test("revokeToken removes the named entry; an unknown name or a missing file is refused", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	assert.match(revokeToken({ path, name: "rob", uid }).invalid, /does not exist, so there is nothing to change/);
	const random = counter();
	const rob = addToken({ path, name: "rob", role: "operator", now, random, uid });
	const ann = addToken({ path, name: "ann", role: "viewer", now, random, uid });
	assert.match(revokeToken({ path, name: "bob", uid }).invalid, /there is no token named "bob"/);
	assert.deepEqual(revokeToken({ path, name: "ann", random, uid }), { ok: true });
	const { file } = readTokensFile({ path, uid });
	assert.deepEqual(file.tokens.map((t) => t.name), ["rob"]);
	assert.equal(findToken(file, ann.token), null);
	assert.equal(findToken(file, rob.token).name, "rob");
	assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

test("rotateToken gives the name a new secret and keeps its role; the old token stops matching", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	const random = counter();
	const old = addToken({ path, name: "view", role: "viewer", now, random, uid });
	const later = () => NOW + 60000;
	const rotated = rotateToken({ path, name: "view", now: later, random, uid });
	assert.notEqual(rotated.token, old.token);
	assert.deepEqual(rotated.entry, { name: "view", role: "viewer", sha256: hashToken(rotated.token), createdAt: new Date(NOW + 60000).toISOString() });
	const { file } = readTokensFile({ path, uid });
	assert.equal(findToken(file, old.token), null);
	assert.equal(findToken(file, rotated.token).name, "view");
	assert.match(rotateToken({ path, name: "nobody", now, random, uid }).invalid, /there is no token named "nobody"/);
	assert.match(rotateToken({ path: join(dir, "absent.json"), name: "view", now, random, uid }).invalid, /does not exist/);
});

test("endAllSessions bumps the generation and keeps every token", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	const random = counter();
	const rob = addToken({ path, name: "rob", role: "operator", now, random, uid });
	assert.deepEqual(endAllSessions({ path, random, uid }), { ok: true, generation: 1 });
	assert.deepEqual(endAllSessions({ path, random, uid }), { ok: true, generation: 2 });
	const { file } = readTokensFile({ path, uid });
	assert.equal(file.generation, 2);
	assert.equal(findToken(file, rob.token).name, "rob");
	assert.match(endAllSessions({ path: join(dir, "absent.json"), uid }).invalid, /does not exist/);
});

test("the file the writers produce parses back to exactly what was written", { skip: !posix }, () => {
	const dir = tempDir("pd-ctok-");
	const path = join(dir, "console-tokens.json");
	addToken({ path, name: "rob", role: "operator", now, random: counter(), uid });
	const text = fs.readFileSync(path, "utf8");
	assert.ok(text.endsWith("}\n"));
	const raw = JSON.parse(text);
	assert.deepEqual(Object.keys(raw), ["version", "generation", "tokens"]);
	assert.deepEqual(parseTokensFile(text, path), raw);
});
