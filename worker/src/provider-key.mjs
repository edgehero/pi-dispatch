/**
 * Which of a provider's credential variables is the one to write, and to name (issue #311).
 *
 * pi's list for a provider is pi's to give: `providerKeyCandidates` in env-allowlist.mjs recovers it from
 * `findEnvKeys` and no copy of it exists anywhere. What pi's list does NOT say is which of its entries is a
 * subscription login rather than a service credential, and that distinction is needed in two places at once:
 * `doctor` has to NAME a variable for an operator to set, and the worker has to CHOOSE one to inject an
 * `auth.json` api-key login under. Those two must never answer differently -- a doctor line naming a
 * variable the worker does not write is exactly the drift issue #286 was about.
 *
 * A SEPARATE MODULE with no imports at all, on the reserved-env.mjs precedent, because the import
 * direction rules out both of the obvious homes. `env-allowlist.mjs` cannot import `doctor.mjs`: that
 * would drag doctor's whole graph into the job path to read one regex. `doctor.mjs` cannot statically
 * import `env-allowlist.mjs` either -- it reaches it through a DYNAMIC import on purpose, so that pi is
 * not loaded before doctor's own Node-floor check has run and printed. A third module with no
 * dependencies is the only shape that lets both have this for free.
 */

// The ONE credential fact this project holds itself, and it has to hold one: this is a statement ABOUT a
// credential that must NOT be used, so it cannot come from pi's table of credentials that DO work --
// that table says which variables pi reads, never which of them is a subscription login.
// Checked and rejected: pi's provider descriptors carry an `auth.oauth` block, but it is per-PROVIDER,
// not per-variable -- `github-copilot` has one and exactly ONE key variable, so "this provider supports
// oauth" cannot name WHICH variable is the token.
// A suffix rule rather than a one-name set, because the expensive direction is the false green: the day
// pi adds a second provider's OAuth variable a set would silently bless it. Pinned against pi in
// worker/test/provider-key.test.mjs -- never against a second copy of a table.
export const OAUTH_KEY_RE = /_OAUTH_TOKEN$/;

/**
 * The api-key variable to write and to name, given pi's candidate list for a provider in pi's own
 * precedence order. Never the OAuth token, whatever that precedence says: pi returns
 * ANTHROPIC_OAUTH_TOKEN first, "set your subscription login" is wrong advice for an unattended service,
 * and an api-key credential written under that name would be a value whose variable lies about what it
 * is. Falls back to the first candidate only for a provider with no non-OAuth variable at all, which is
 * no provider pi has today; `null` for a provider pi reads no key variable for, which is the caller's
 * cue to refuse rather than to guess.
 */
export function apiKeyVariable(candidates) {
	return candidates.find((name) => !OAUTH_KEY_RE.test(name)) ?? candidates[0] ?? null;
}
