/**
 * The code fence every piece of untrusted text in a prompt is wrapped in (CONST-ISSUE-TEXT-IS-DATA's render barrier).
 *
 * Moved here from github-prompt.mjs (issue #646) so the steer framing (steer-framing.mjs) can fence a running job's
 * message with the SAME rule the trigger's own text gets, without importing a prompt builder (and its branch and
 * session imports) to reach one function. github-prompt.mjs imports it back, so there is still exactly one fence rule:
 * two copies would drift, and the one that drifted would be the one a crafted body escapes.
 *
 * Wrap untrusted content in a code fence long enough that the content cannot close it early. A `##` heading or a
 * shorter backtick run inside the payload then renders literally, inside the fence, rather than escaping the data
 * region. The fence is defense in depth, not the boundary: placement as a user turn is (see github-prompt.mjs).
 */
export function fenceBlock(content) {
	const runs = String(content).match(/`+/g) ?? [];
	const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}text\n${content}\n${fence}`;
}
