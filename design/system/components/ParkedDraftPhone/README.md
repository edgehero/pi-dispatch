The Parked page on a phone, with an answer rule drafting (proposed). Two questions wait; each card has one action, and neither shows the question or the draft.

**How a person uses it.**
- **Yours to answer.** gh-2f6a on acme/api#131: where to read the question (the issue, or its run page), why no draft was made ("a product decision"), the answer box and **Preview answer**.
- **Drafted for you.** gh-6e1d on acme/web#512: the draft run that made it (gh-a07c), the sources it cites by name, Jev's two answers in one line, and **Open the draft**, which opens the run page where the draft fills the answer box. Sending is the usual preview and Confirm.
- **Sent from a draft today** and **the answer rule** are one line each.

**Panels.** `p-yours`, `p-drafted`, `p-answered` (one line), `p-answerer` (one line).

**The server provides.** The same reads as ParkedAnswerer. The phone leaves out *Answer myself*, *Don't draft these*, the standing answers and the rule's settings, which are one tap away on the run page and the rule's page.

**Who sees what.** An operator's phone. A viewer's phone shows ParkedDraftViewer's content, stacked.

**Fixture note.** As ParkedAnswerer: gh-2f6a, acme/api#131, triage on mini1 and parked 26 minutes are the fixture; gh-6e1d, gh-5a02, gh-a07c and the sources are sample, because answer rules are proposed (issue #753, REQ-PARKED-ANSWERER).
