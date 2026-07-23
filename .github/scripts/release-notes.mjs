/**
 * AI-written GitHub Release notes for `@edgehero/pi-dispatch-admin`.
 *
 * Reads the commit list (COMMITS), the version (VERSION), and the key (ANTHROPIC_API_KEY) from the
 * environment, asks Claude for concise, grouped Markdown notes, and prints them to stdout. Exits NON-ZERO on
 * any failure so the release workflow falls back to a plain commit list — a missing key or a flaky API never
 * blocks the release. Model is overridable via RELEASE_MODEL (default: a current Sonnet).
 */
const key = process.env.ANTHROPIC_API_KEY;
const commits = (process.env.COMMITS || "").trim();
const version = process.env.VERSION || "";
const model = process.env.RELEASE_MODEL || "claude-sonnet-5";

if (!key) { console.error("release-notes: ANTHROPIC_API_KEY not set"); process.exit(1); }
if (!commits) { console.error("release-notes: no commits provided"); process.exit(1); }

const prompt = [
	`Write GitHub Release notes in Markdown for \`@edgehero/pi-dispatch-admin\` ${version} — the operator`,
	`extension (a pi coding-agent extension) for the pi-dispatch self-hosted agent service.`,
	`Group changes under short bold headings (e.g. **Features**, **Fixes**, **Docs**) where relevant, as terse`,
	`user-facing bullet points — not a raw commit dump. Drop chore/CI-only noise. No title line, no preamble.`,
	``,
	`Commits since the last release:`,
	commits,
].join("\n");

let res;
try {
	res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
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
process.stdout.write(`${text.trim()}\n`);
