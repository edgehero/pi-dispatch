# Answer rules

An answer rule starts a capped job when a listed project’s forge run parks. It classifies the actual posted
question, then proposes an answer from sources it read. A person alone sends it through the existing answer
preview and Confirm. Approvals never start a draft job. Draft jobs post no comments and never change the source
run’s transcript. After posting a question, the source flow should pass the forge’s returned comment ID as
`await_human_input({questionCommentId: "123"})`. The signed park binds that exact reference. A missing or tampered
reference passes as source-unavailable rather than guessing from a transcript or buying a draft.

Write rules by hand in the deployment’s `triggers.json`. The console shows them read only at `/parked/rules`.
No model tool accepts either `answerRules` or `standingAnswers`, including nested or alternate spellings.
This template uses placeholder model identities; replace both with explicit installed models, including a
classifier-capable decision model with declared cost, such as `openrouter/typesafe/jev-1.13` or, since pi 1.6.1,
`github-copilot/gpt-6-luna-decisions` (on `COPILOT_GITHUB_TOKEN`; a Copilot sign-in is refused). A Radius decision
model is refused: its cost comes from Radius's server, so the draft's cap cannot bound it
([costs.md](costs.md#pi-140-summaries-and-radius)). No provider key belongs in this file. Both models take the
host's credentials unless the rule names its own key by reference ([below](#a-key-of-the-rules-own)); a key a trigger
declares in its `run.secrets` never reaches an answer draft.

```json
{
  "answerRules": [{
    "id": "repository-conventions",
    "projects": ["example"],
    "categories": ["convention", "how-to", "decided"],
    "confidence": 0.9,
    "mode": "classify",
    "flow": "answer-question",
    "model": "provider/generation-model-id",
    "decisionModel": "provider/classifier-model-id",
    "maxCostUsd": "0.10"
  }],
  "standingAnswers": [{
    "id": "test-command",
    "title": "Repository test command",
    "text": "Run npm test from the repository root.",
    "projects": ["example"],
    "repo": "github:example/project"
  }]
}
```

The flow must exist as `.pi/skills/<flow>/SKILL.md` at the repository’s prepared default-branch commit. Its
reviewed text is materialized into the prompt (at most 16 KiB, valid UTF-8, no symlink path). It cannot execute
scripts or enable tools. An absent or unsafe flow refuses; naming it does not silently select a generic flow.
The worker rechecks the exact current park, live approval, pending answers and current forge identity before it
buys any draft. Completed proposals are also bound to the captured forge root/account: changing them hides
the proposal and refuses its queued send before minting a token or posting.

Start with `classify`, which records verdicts and probabilities without drafting. Change to `draft` after
reviewing them. Confidence must be above 0.5 and at most 1; each project belongs to at most one rule. The closed
allowed categories are existing conventions, documented procedures and decisions already recorded. Product,
security, money, scope, approval and uncovered questions always pass to a person. A separate source-coverage
classification must also pass. A classification call spends inside the same reserve as generation.

Sources are standing answers matching both project and forge-qualified repository, repository files at the
prepared default-branch SHA, and earlier replies from admitted authors on that repository’s issues. Citations
bind the source revision. Arbitrary URLs, external private repositories and the model’s memory are not sources.
External skills can interpret private persona/project guidance later and propose ordinary bounded platform
actions; they cannot add authority or credentials to a draft.

The Parked list shows operators the verdict, source names and draft-run link. The source run page offers the
question, draft, citations and answer form. Preview binds the draft ID/digest; Confirm rechecks the rule, project
and source/configuration before queueing. A stale/dropped draft refuses with a named reason. “Answer myself”
opens the ordinary answer path; “Don’t draft these” shows a narrower configuration proposal for hand review.
The viewer and agent projections contain no source, classification, rule, standing text or draft.

After sending, the optional adoption checkbox prepares a separate standing-answer preview with the exact text
sent. Confirm that separately. If adoption fails, the queued answer remains queued and the proposal remains
unsaved. You may also add standing guidance directly. Adoption is audited as `standing-answer-add`; no answer
body appears in an audit row.

The worker records named passes for absent/oversized sources, legacy parks lacking an exact question reference,
low confidence, disallowed categories and changed configuration. The private store expires with retention,
capped at 90 days even on keep-forever deployments. A pending scheduling failure can retry; a determinate pass
does not buy another job. The image must declare `answerDraft`; older images refuse before spend. Draft helpers
have ordinary metered run records but do not supersede the parked workload or inflate Zero touch counts.

## A key of the rule's own

A rule may bring its models' provider keys, as a trigger does in `run.secrets` ([secrets](secrets.md)): `secrets`
maps a provider's API-key variable to a reference your resolver reads, and `secretsProfile` names the resolver, as on
a trigger. The file then needs triggers file version 12, which the console's writers stamp.

```json
"secrets": { "OPENAI_API_KEY": "op://ci/openai/key", "ANTHROPIC_API_KEY": "op://ci/anthropic/key" },
"secretsProfile": "vault"
```

- **Only API-key variables.** A name follows the rules of `run.secrets`, and must be the API-key variable of a
  provider pi knows. Anything else is refused when the file loads, naming the rule and the variable: an OAuth or
  bearer variable (`ANTHROPIC_OAUTH_TOKEN`, `..._AUTH_TOKEN`), a variable of a provider that needs host
  authentication, and a name no model could take, such as `DATABASE_URL` or the typo `OPENAI_APIKEY` (the refusal
  names `OPENAI_API_KEY`). Such a name would otherwise leave the model it was meant for on this host's key.
- **Only the draft's own providers.** The draft job receives a key only when its model's provider or its decision
  model's provider reads it. The key of another provider (an `anthropic` key on a rule whose models are both `openai`)
  is withheld, nothing is resolved for it, and the worker logs `declared_key_withheld` with the rule and the names;
  `pi-dispatch doctor` warns about it, and the rule's page lists it as not passed.
- **The declared key is the only key.** The host's key for that provider never reaches the job. An empty value, or one
  the resolver cannot give, refuses the draft before anything spends; the host's key does not stand in for it. A name
  on `PI_FORWARD_ENV`, a provider that needs host authentication, and a provider bound to a subscription on this host
  refuse the draft before it spends, as they refuse a trigger's job (`secret-name-reserved`, or
  `provider-unconfigured` on a host with no credential of its own for that provider).
- **The profile must be declared on every worker that runs drafts.** A draft job goes to whichever worker takes it,
  so a profile only one host declares refuses the draft as `secret-profile-unknown` on another.
- **Adding or changing it ends drafts in flight.** The rule's configuration digest covers its keys, so a draft queued
  before the change passes as `config-changed` and buys nothing.
- **Upgrade every worker, receiver and console first.** An older one refuses a version 12 file and keeps the triggers
  it had ([upgrading](upgrading.md)).
