The Parked page shows typed approval requests alongside parked questions. The gate action and its enforcement boundary are visible; the agent's summary stays on its issue and run transcript.

## How a person uses it
- Read the request on the forge or run page, then preview approval, preview a decline with an optional reason, or ask a question.
- Every choice uses the existing audited preview and confirmation action. A question resumes the agent without granting approval.
- Budget raises use the trigger's declared cap within deployment and scoped limits. External actions are advisory. Default-branch pushes and PR-open gates are refused until they can be enforced.
- Viewers and read-only consoles show the request without decision controls.

## Panels
`p-questions`.

## The server provides
Run id, target, project, parked time, declared gate action and whether the existing answer planner permits a reply. Model text is never stored in the run record or copied into the inbox.

## Fixture note
The budget-raise request is illustrative. The production inbox uses the existing question-card and answer-form kit, and shows both request kinds together rather than hiding either behind a tab.
