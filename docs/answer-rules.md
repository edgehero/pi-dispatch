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
classifier-capable decision model with declared cost. No provider key belongs in this file.

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
