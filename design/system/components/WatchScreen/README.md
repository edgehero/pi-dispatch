Watch shows configured sources and rules before the first finding, retained finding outcomes, cooldown left, and suppressed or capped counts. Built by #735.

**How a person uses it.** Open Watch from Configuration's Triggers section when a watch rule is configured. The compact static screen lists source signatures, latest delivery, refusal counters and explicitly unknown credential health. Doctor checks source credentials on their owning host. Rules show source, reviewed flow, mode and daily cap. Select a rule's board for retained findings and operator-only evidence. The terminal panel's z key opens Watch findings and outcome counters.

**Panels.** The delivered console has `p-watch`, containing Sources, Watch rules and Findings.

**Who sees what.** Both roles see counts and outcomes. Samples are operator only on the board's evidence section and never enter run history or application logs. Watch configuration is hand-written; the generic trigger editor does not author it.

**Why it works this way.** Signature verification precedes parsing. Deterministic rules, cooldown and source and rule caps precede spend. Each investigation is a fresh read-only container, and a person with write access authorizes a code-change follow-up. A finding cannot choose the flow, model, folder, permissions, secrets or image.

**Future design, not delivered.** The earlier multi-panel live Watch dashboard is a future presentation option. This card describes the compact retained-data screen, not live widgets or receiver credential-health telemetry.

**Fixture note.** Counts and timestamps are illustrative and match the board's shared finding and local-7f21 job.
