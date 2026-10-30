The Parked page at phone width: each parked run is a card with who asks, its target and wait time, where to read the question, and an answer box one tap from the preview.

## How a person uses it
- The person opens the console from a notification. Questions and approvals share the inbox and its count.
- The question card shows who asked, the project and target, how long it has waited, and where to read the question: on its issue or pull request, or on its run page while its transcript is kept.
- **Preview answer** opens the same two-step confirm as the run page. Nothing is posted until they confirm.
- Below the questions, a compact card shows the approval that also waits (#649): the action, the target, the risk line, and Approve or Decline as full-width buttons.
- Everything fits 390px with no sideways scroll; the nav pills scroll inside their own row.

## Panels
`p-questions`, `p-approvals`.

## The server provides
Parked runs (questions and approval requests) with their target, project and wait time, and whether an answer can be built here. Never the question or the gate's text.

## Why it works this way
The question is the run's last message, text a run wrote after reading issue text. The console shows it on the run page and nowhere else (REQ-CONSOLE-SECURITY (l)), so this card says where to read it, as the shipped page does.

## Fixture note
From the fixture: gh-2f6a, acme/api#131, triage on mini1, parked 26 minutes. The budget-raise approval is sample content. Approval controls are built by #649.
