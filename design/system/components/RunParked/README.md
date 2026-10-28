The run page for a parked run: the agent's question is the hero, with the answer box and the two-step confirm right under it.

## How a person uses it
- The question card shows who asked (gh-2f6a, `api`, acme/api#131), how long it has waited and the question in large text.
- The person writes an answer and previews it. The preview says it is posted to acme/api#131 as a reply and resumes the run, that the session continues, and what is reserved before the first token. **Post answer and resume** confirms; the undo line says how to take it back.
- A terminal route stays available: `pi-dispatch chat gh-2f6a`.
- When the queue no longer holds the run's data, the answer box is replaced by an attention banner that sends the person to the issue, where a reply still resumes the run. Both states are shown on this card.
- The side column holds the run facts, tokens and dollars against the job cap, and the last three transcript entries.

## Panels
`p-chat` (question, answer, preview), `p-run`, `p-spend`, `p-tail`.

## The server provides
The parked run record, the question (the last assistant entry, untrusted text, escaped), whether the queue still holds the job's data (so an answer can be built here), the session-keeping trigger, the job cap and the reservation, and the transcript tail.

## Fixture note
From the fixture: gh-2f6a, acme/api#131, triage on mini1, local, trigger 7 (index 6 in the fixture file; label pi:triage, keeps a session, MCP linear), 11 turns, $0.21 (settled $0.209633), 74,953 in, 5,523 out, 125,448 total, 11 model calls, 14:52 to 15:13 UTC, and the "cannot be answered here" state. The question, the typed answer and the transcript tail are sample copy.
