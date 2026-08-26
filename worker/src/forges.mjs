/**
 * THE FORGE TABLE -- the one place that says which forges exist and what differs between them.
 *
 * Before this file, "which forges are there" was written down in nine places: two enumerations in
 * `triggers.mjs`, a `groups` literal in the receiver's config, a filter in `doctor.mjs`, two
 * near-identical `enqueue*Job` bodies, two near-identical `*DeliveryJobId` bodies, and a token-variable
 * set that had to agree with a mint written twenty lines away. Adding a forge meant finding all nine.
 *
 * Some of those fail LOUDLY when you miss one -- `triggers.mjs` refuses the file and names the bad kind,
 * which is a fine way to find out. The reason this file exists is the ones that fail SILENTLY: a missing
 * entry in the receiver's `groups` throws inside a reload that catches everything and keeps yesterday's
 * rules; a missing token-variable name is simply not refused in `PI_FORWARD_ENV`. Deriving them all from
 * one table does not make the table correct, but it makes "did I miss one" a question with a single
 * answer, and lets a test assert that answer (`Object.keys(x)` against `FORGE_KINDS`).
 *
 * This module imports NOTHING, deliberately. It is the leaf of the worker's module graph -- `triggers.mjs`
 * needs it and `triggers.mjs` is itself imported by the receiver's config, so anything this file reached
 * for would be pulled into both services. That also means it cannot use `configError`: a lookup returns
 * `undefined` for an unknown kind and the CALLER decides how loudly to fail, which is right anyway,
 * because the answer differs (a trigger file refuses to load; a container env refuses to build).
 */

/**
 * What differs per forge. Every field here is a fact this codebase branched on somewhere before it was
 * a table.
 *
 * - `jobIdPrefix` keeps the forges' delivery-id spaces disjoint, so a delivery id that happened to
 *   collide across two forges could never suppress the other's job (REQ-DEDUP-BY-DELIVERY-GUID).
 * - `deliveryIdName` is only ever used in an error message, and is here so the message names the header
 *   the operator has to go and look at rather than a generic "missing id".
 * - `pullRequestSep` is the notation the forge itself uses for a pull/merge request, and it is load-bearing
 *   twice: in the semantic dedup key and in the durable run record's `target`. GitHub numbers issues and
 *   pull requests from ONE per-repo sequence, so `#` serves both and `repo#7` names exactly one thing.
 *   GitLab numbers them separately, so `!` has to distinguish them or issue #5 and merge request !5
 *   collide. That is a fact about each forge, not a style choice.
 * - `tokenVars` are the variable names this forge's CLI reads its credential from. They are also the
 *   names that must be refused in `PI_FORWARD_ENV`, and those two lists being derived from one entry is
 *   the point: a forge added to the mint but not to the refusal set is a long-lived host token forwarded
 *   into every container, and nothing would have said so.
 * - `hostVar` is where a self-hosted instance URL lands in the container, or `null` for a forge that has
 *   no instance concept in this codebase yet.
 * - `prLabelAction` is this forge's `pull_request` action meaning "a label changed", or `null` where the
 *   forge has no distinguishable one. It decides whether a rule naming that action must carry a positive
 *   selector, and the reason is independent of who is gating: a rule keyed on labels that names no labels
 *   is a rule that fires on ALL of them. GitLab's is null because a label added to a merge request arrives
 *   as a plain `update`, indistinguishable from any other edit -- there is no action to attach the rule to.
 */
export const FORGES = {
	github: {
		jobIdPrefix: "gh-",
		deliveryIdName: "X-GitHub-Delivery GUID",
		pullRequestSep: "#",
		tokenVars: ["GITHUB_TOKEN", "GH_TOKEN"],
		hostVar: null,
		prLabelAction: "labeled",
	},
	gitlab: {
		jobIdPrefix: "gl-",
		deliveryIdName: "webhook-id / Idempotency-Key",
		pullRequestSep: "!",
		tokenVars: ["GITLAB_TOKEN", "GL_TOKEN"],
		hostVar: "GITLAB_HOST",
		// A label added to a merge request arrives as a plain `update`, indistinguishable from any other
		// edit, so there is no action for a positive-selector rule to attach to. (Separately, a GitLab label
		// is not an approval at all -- a Guest can set one at issue creation -- which is why every gitlab
		// trigger is gated on the actor's resolved access level.)
		prLabelAction: null,
	},
	forgejo: {
		// Forgejo's webhook transport is byte-compatible with GitHub's -- it signs the raw body HMAC-SHA256
		// and sends X-Hub-Signature-256, X-GitHub-Delivery and X-GitHub-Event. So the delivery id is a GUID
		// with the same across-retry stability GitHub's has, and REQ-DEDUP-BY-DELIVERY-GUID transfers
		// unchanged. Only the PREFIX differs, and only so the id spaces stay disjoint.
		jobIdPrefix: "fj-",
		deliveryIdName: "X-GitHub-Delivery GUID",
		// Forgejo numbers issues and pull requests from ONE per-repository sequence, exactly as GitHub does
		// -- an issue and a PR cannot share an index. So `#` names one thing and no discriminator is needed.
		pullRequestSep: "#",
		// `tea` reads GITEA_SERVER_TOKEN; the unprefixed name is what the API examples and most scripts use.
		tokenVars: ["FORGEJO_TOKEN", "GITEA_SERVER_TOKEN"],
		hostVar: "FORGEJO_HOST",
		// Forgejo names the action, so the positive-selector rule applies exactly as it does on GitHub.
		// Note this is HYGIENE, not the gate: unlike GitHub, every forgejo trigger is additionally gated on
		// the actor's resolved repository permission -- see filter-forgejo.mjs for why that is not
		// redundant belt-and-braces but the only claim about Forgejo this project is willing to make.
		prLabelAction: "label_updated",
	},
	azure: {
		// Azure Service Hooks send NO delivery-id header at all, so this id comes from the body's top-level
		// `id` GUID -- the one departure `verify-gitlab.mjs` explicitly refuses to make, taken here because
		// the refusal is right for a forge that HAS a header and inapplicable to one that has none.
		// (Issue #43 proposes `notificationId`, which is a per-subscription integer sequence: two
		// subscriptions collide on delivery 1.)
		jobIdPrefix: "az-",
		deliveryIdName: "service hook payload id",
		// Azure numbers work items and pull requests from SEPARATE sequences -- work item ids are
		// organization-scoped, pull request ids are not -- so `project/repo#123` and `project/repo!123` are
		// different objects and would collide on one separator, exactly as GitLab's issue #5 and MR !5 do.
		pullRequestSep: "!",
		// `az repos` reads AZURE_DEVOPS_EXT_PAT; SYSTEM_ACCESSTOKEN is what a pipeline-shaped script expects.
		tokenVars: ["AZURE_DEVOPS_EXT_PAT", "SYSTEM_ACCESSTOKEN"],
		hostVar: "AZURE_DEVOPS_ORG_URL",
		// Azure attaches no labels to a pull request at all, so there is no action to attach the rule to and
		// a predicated PR rule could never match. The loader refuses one rather than letting it load dead.
		prLabelAction: null,
	},
};

/**
 * The forge kinds, in table order. An ARRAY rather than a Set because most consumers want to iterate it
 * to build something keyed by kind, and the two that want membership say `in FORGES` instead.
 */
export const FORGE_KINDS = Object.freeze(Object.keys(FORGES));

/** Every job kind a trigger may name: the forges, plus `local`, which has no forge at all. */
export const RUN_KINDS = Object.freeze(["local", ...FORGE_KINDS]);

/** Whether `kind` names a forge. `local` is not one, and that distinction IS the on x run matrix. */
export function isForgeKind(kind) {
	return typeof kind === "string" && Object.hasOwn(FORGES, kind);
}

/**
 * The table row for `kind`, or `undefined`. Total, and never throws -- see the module header for why the
 * caller owns the failure.
 */
export function forgeSpec(kind) {
	return isForgeKind(kind) ? FORGES[kind] : undefined;
}

/**
 * Every environment variable name any forge's mint can write. This is the set `PI_FORWARD_ENV` must
 * refuse: a forwarded host value under one of these names would shadow the per-job scoped token with a
 * long-lived one, which is the whole of CONST-TOKEN-SCOPED-PER-JOB defeated by a config line.
 */
export const MINTED_TOKEN_VARS = new Set(FORGE_KINDS.flatMap((kind) => FORGES[kind].tokenVars));

/**
 * Every environment variable name any forge's SELF-HOSTED INSTANCE URL can land in. A sibling of
 * `MINTED_TOKEN_VARS` and derived the same way, from the table rather than by hand, so a forge added
 * later cannot be missed here either.
 *
 * Separate from `MINTED_TOKEN_VARS` because `hostVar` is a separate column: the token set is
 * `tokenVars` only, so a name like `GITLAB_HOST` is in NEITHER set until this one exists. That gap is
 * not theoretical -- `buildContainerEnv` writes this variable after the mint, so a trigger field able
 * to name it would be silently overwritten, and the job would run without the value it asked for on a
 * clean exit 0. github's row is `null` and contributes nothing, which is why the filter is here and
 * not at the call site.
 */
export const FORGE_HOST_VARS = new Set(FORGE_KINDS.map((kind) => FORGES[kind].hostVar).filter((name) => typeof name === "string"));

/**
 * The separator between a repo label and a target number, for this forge and this target type: the
 * forge's own notation for a pull/merge request, and `#` for an issue everywhere.
 *
 * Unknown kinds get `#` rather than a throw, because both callers are LABEL builders -- a run record's
 * `target` and a dedup key. Neither is a gate, and neither should be able to fail a job over punctuation.
 */
export function targetSeparator(kind, targetType) {
	if (targetType !== "pull_request") return "#";
	return forgeSpec(kind)?.pullRequestSep ?? "#";
}
