The Parked page at phone width: each parked question is a card with the question, its target and wait time, and an answer box one tap from the preview.

## How a person uses it
- The person opens the console from a notification. Questions and approvals share the inbox and its count.
- The question card shows who asked, the project and target, how long it has waited and the question in large text.
- **Preview answer** opens the same two-step confirm as the run page. Nothing is posted until they confirm.
- Below the questions, a compact card shows the approval that also waits (#649): the action, the target, the risk line, and Approve or Decline as full-width buttons.
- Everything fits 390px with no sideways scroll; the nav pills scroll inside their own row.

## Panels
`p-questions`, `p-approvals`.

## The server provides
Parked runs (questions and approval requests) with their target, project, wait time, question or gate text (untrusted, escaped) and whether an answer can be built here.

## Fixture note
From the fixture: gh-2f6a, acme/api#131, triage on mini1, parked 26 minutes. The question text and the budget-raise approval are sample content. Approval controls are built by #649.
