The Parked page as a viewer sees it, with an answer rule drafting (answer rules). A viewer learns that runs wait for a person and for how long, never what they asked or what was drafted.

**How a person uses it.**
- **Waiting for a person, 2.** One card per question: the run, its project and target, what ran where, when it parked and how long it has waited, and where the question can be read (its issue). gh-2f6a waits for an answer; gh-6e1d has a draft ready, which an operator reads and sends.
- **Answered today.** gh-5a02 on acme/web#498 was answered by ops, from a draft, and the run completed.
- One line says answers, drafts, their sources and the answer rule are for operators.

**Panels.** The two question cards, `p-answered` (one line), and the operators-only line.

**The server provides.** For a viewer's session: each parked run's id, project, target, flow, host, parked time and wait, whether a draft exists, and who answered a finished one. Never the question, the draft, its sources, Jev's classification, why a draft was not made, the answer form or the rule.

**Who sees what.** This is the viewer's page: no forms, no actions, no answer-rule card. "Why no draft was made" (a product decision) is a classification, so it is left out too.

**Fixture note.** As ParkedAnswerer: gh-2f6a and acme/api#131 are the fixture; gh-6e1d and gh-5a02 are sample (issue #753).
