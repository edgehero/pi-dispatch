import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import { answerTrailComment, PANEL_ANSWER_BY, scrubAnswerText } from "../src/console-answer.mjs";

// Issue #642: the trail comment quotes an operator's answer on the forge under the deployment's identity. What the forge
// RENDERS is the property, so the HTML cases are rendered with a real markdown renderer (marked, already in the tree as a
// pi dependency), the way a forge renders a comment: raw HTML passes through.

const HEAD = "Answered from the operator console by alice:\n\n";

test("an answer holding `<!--` cannot hide the rest of the quote: rendered, every line is still visible", () => {
	const trail = answerTrailComment("alice", "first <!-- hidden\nsecond line\n-->third");
	assert.equal(trail, `${HEAD}> first &lt;!-- hidden\n> second line\n> --&gt;third`);
	assert.doesNotMatch(trail.slice(HEAD.length), /</, "no `<` survives in the quoted text");
	const html = marked.parse(trail);
	assert.doesNotMatch(html, /<!--/, "no HTML comment reaches the rendered page");
	for (const visible of ["first &lt;!-- hidden", "second line", "--&gt;third"]) assert.ok(html.includes(visible), `${visible} is rendered: ${html}`);
});

test("a tag cannot open, and a `>` cannot nest a quote of its own", () => {
	const trail = answerTrailComment("alice", '<img src=x onerror=alert(1)><details><summary>x</summary>\n> nested');
	assert.equal(trail, `${HEAD}> &lt;img src=x onerror=alert(1)&gt;&lt;details&gt;&lt;summary&gt;x&lt;/summary&gt;\n> &gt; nested`);
	const html = marked.parse(trail);
	assert.doesNotMatch(html, /<img|<details|<summary/);
	assert.equal(html.match(/<blockquote>/g).length, 1, "one quote, never a deeper one the operator did not type");
});

test("an entity-encoded mention (`&#64;`, `&commat;`) does not decode to a live `@`: the `&` is escaped first", () => {
	const trail = answerTrailComment("alice", "ping &#64;octo-org/team and &commat;alice and @bob");
	assert.equal(trail, `${HEAD}> ping &amp;#64;octo-org/team and &amp;commat;alice and @\u200bbob`);
	const html = marked.parse(trail);
	assert.doesNotMatch(html, /@(?!\u200b)/, "the rendered page holds no `@` that is not neutralised");
	assert.ok(html.includes("&amp;#64;octo-org"), "the entity shows as the text typed, not as an @");
});

test("every bidi mark and isolate is removed: U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069", () => {
	const marks = ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"];
	for (const m of marks) {
		assert.equal(scrubAnswerText(`a${m}b`), "ab", `U+${m.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} is removed`);
		assert.equal(answerTrailComment("alice", `a${m}b`), `${HEAD}> ab`);
	}
});

test("line endings: `\\r\\n`, a lone `\\r`, U+2028 and U+2029 all become a new quoted line, never a break inside one", () => {
	assert.equal(scrubAnswerText("a\r\nb\rc\u2028d\u2029e"), "a\nb\nc\nd\ne");
	assert.equal(answerTrailComment("alice", "a\rb\u2029c"), `${HEAD}> a\n> b\n> c`);
	assert.doesNotMatch(answerTrailComment("alice", "a\rb\u2028c\u2029d"), /[\r\u2028\u2029]/);
});

test("an answer from the panel's /dispatch chat (issue #647 part 2) says it came from the panel, never \"by panel\" as if a token named it", () => {
	assert.equal(PANEL_ANSWER_BY, "panel");
	assert.equal(answerTrailComment(PANEL_ANSWER_BY, "use main\n@bob"), "Answered from an operator's /dispatch panel:\n\n> use main\n> @\u200bbob");
	assert.equal(answerTrailComment("panel2", "x"), "Answered from the operator console by panel2:\n\n> x", "only the exact reserved word");
});
