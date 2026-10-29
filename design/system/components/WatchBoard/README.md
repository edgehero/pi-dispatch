A watch rule's retained finding history and board, built by #735 and #743. The delivered console uses a compact static page, reached from Watch. Reload reads current data; it is not a live shadow dashboard.

**How a person uses it.**
- Open a finding to see the source, deterministic rule checks, decision options and probabilities, and the resulting job or issue.
- Read the adopted board version. Jobs propose inert blocks: number, line chart, table, note, hypotheses and timeline. Only an operator adopts, freezes, unfreezes, restores or clears it, through Preview and Confirm with an audit row and a version check.
- Compare the proposed blocks in the adoption preview. The board stores data, never executable query configuration. Adoption does not install a query or automatically rerun one.
- Read classifier totals for the loaded retained findings: decision count, known spend, missing cost count and actions. At the 1,000-finding bound the console says the figures are a floor.
- An operator reads redacted samples, query text, decision state and questions as escaped text in the page's details. The JSON download uses the same operator-only boundary.

**Panels.** The delivered page has one panel, `p-watch-board`, containing the rule, board, finding history, decision model totals and evidence.

**Who sees what.** A viewer sees counts, rule checks, chosen options and probabilities, and board version/block/proposal counts. Agent-authored board values, including numeric query results, remain operator only. Samples, query text, decision state, note text, proposed blocks and board controls are operator only. The static page reads private evidence only for an explicit operator session. No private field enters the shared hub or `/api/state`.

**Why it works this way.** Each finding is a fresh bounded job, at most 30 minutes. Free rule checks precede any paid decision or job. Gate decisions default to shadow and act only after a reviewed opt-in, in a one-call container. Human adoption is the board's persistence boundary; no transcript carries into the next job. The console renders its own block markup and the CSP is unchanged.

**Future design, not delivered.** The earlier live shadow charts, continuously refreshed query projections, spend-rate projections and historical shadow agreement dashboard remain possible future work. They are not claims about this compact screen.

**Fixture note.** Finding counts, probabilities, costs, proposals and trace entries are illustrative. The finding and local-7f21 follow the shared Watch fixture. Runtime tests and pinned model artifacts establish behavior; the card does not establish provider pricing.
