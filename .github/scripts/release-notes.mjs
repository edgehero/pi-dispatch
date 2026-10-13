/**
 * AI-written GitHub Release notes, for whichever artifact is being released.
 *
 * Reads the commit list (COMMITS), the version (VERSION), the subject (PRODUCT, PRODUCT_DESC) and the key
 * (ANTHROPIC_API_KEY) from the environment, asks Claude for notes, and prints them to stdout. Exits
 * NON-ZERO on any failure so the release workflow falls back to a plain commit list — a missing key or a
 * flaky API never blocks a release. Model is overridable via RELEASE_MODEL (default: a current Sonnet).
 *
 * PRODUCT is READ rather than hard-coded because two workflows call this script: release.yml ships the
 * admin extension (`admin-v*`) and repo-release.yml ships the whole tool (`v*`). It named the extension
 * unconditionally, so every tool release asked the model to describe the operator extension and then
 * handed it repo-wide commits to describe it with. The name is the caller's fact, not this file's.
 *
 * THE LENGTH CEILING IS IMPOSED HERE, NOT REQUESTED IN THE PROMPT. These notes are read in the few seconds
 * between seeing a tag and deciding whether to upgrade; asking for "terse bullet points" produced 694 words
 * of prose, section headings and a config sample at v0.3.0. So the prompt asks for the shape and `tighten`
 * then enforces it — a prompt that asks for brevity is a request, and a slice is a guarantee. Detail is not
 * lost, it is relocated: the workflow appends a compare link, which is what lets these stay short.
 */
const MAX_BULLETS = 5;

const key = process.env.ANTHROPIC_API_KEY;
const commits = (process.env.COMMITS || "").trim();
const version = process.env.VERSION || "";
const product = process.env.PRODUCT || "pi-dispatch";
const productDesc = process.env.PRODUCT_DESC || "a self-hosted service that runs pi coding-agent jobs";
const model = process.env.RELEASE_MODEL || "claude-sonnet-5-5";

if (!key) { console.error("release-notes: ANTHROPIC_API_KEY not set"); process.exit(1); }
if (!commits) { console.error("release-notes: no commits provided"); process.exit(1); }

const prompt = [
	`Write GitHub Release notes in Markdown for ${product} ${version} — ${productDesc}.`,
	``,
	`Someone reads these for about five seconds and decides whether to upgrade. Write for that reader.`,
	``,
	`Shape, exactly:`,
	`- One opening line, bold, saying what this release IS in at most 20 words. Never "this release contains".`,
	`- Then at most ${MAX_BULLETS} bullets, one line and at most 20 words each, most important first.`,
	`- A bullet names a user-visible change, not a commit. Fold related commits into one bullet.`,
	`- If something is opt-in or changes nothing unless configured, say so in the bullet — briefly.`,
	`- Drop CI, chores, refactors, and docs-only or spec-only commits entirely.`,
	``,
	`No title, no preamble, no headings, no code blocks, no sub-bullets, no closing summary.`,
	``,
	`Commits since the last release:`,
	commits,
].join("\n");

let res;
try {
	res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
		// Sized to the shape above rather than to the model's appetite: a headline and five one-line bullets
		// do not need 1200 tokens, and a budget that cannot fit an essay cannot produce one.
		body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
	});
} catch (err) {
	console.error("release-notes: request failed:", err?.message ?? err);
	process.exit(1);
}
if (!res.ok) {
	console.error("release-notes: HTTP", res.status, (await res.text()).slice(0, 300));
	process.exit(1);
}
const data = await res.json();
const text = data?.content?.find?.((b) => b.type === "text")?.text;
if (!text) { console.error("release-notes: no text in response"); process.exit(1); }

const notes = tighten(text);
// An empty result means the model answered in a shape with nothing left after tightening (all headings, or
// a fenced block and nothing else). Non-zero hands the workflow its commit-list fallback, which is worse
// prose but is at least true — silently publishing an empty release body is the one outcome to avoid.
if (notes === "") { console.error("release-notes: nothing left after tightening"); process.exit(1); }
process.stdout.write(`${notes}\n`);

/**
 * The ceiling, imposed rather than asked for: drop fenced blocks and headings, keep the opening line and
 * the first MAX_BULLETS top-level bullets, and stop at the first unindented prose line that follows them.
 *
 * Truncating the TAIL is the right thing to lose, because the prompt orders bullets most-important-first —
 * so a model that ignores the count still yields the changes that mattered, in order, and the compare link
 * the workflow appends carries anyone who wants the rest.
 */
function tighten(markdown) {
	const stripped = markdown
		.replace(/```[\s\S]*?```/g, "")
		.replace(/^[ \t]*#{1,6} .*$/gm, "");

	const out = [];
	let bullets = 0;
	for (const line of stripped.split("\n")) {
		const isBullet = /^[ \t]*[-*] /.test(line);
		if (isBullet && ++bullets > MAX_BULLETS) break;
		// Once the list has started, an unindented prose line is the closing summary the prompt forbade.
		// Blank lines and indented continuations of a wrapped bullet are kept, so nothing ends mid-sentence.
		if (bullets > 0 && !isBullet && line.trim() !== "" && !/^[ \t]/.test(line)) break;
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
