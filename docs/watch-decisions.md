# Watch decisions, traces and boards

An optional decision block classifies a finding before the investigation. It defaults to shadow mode: the decision is recorded while the original rule action stays in control. Set `shadow: false` in reviewed configuration to activate its choices. An active low-probability or unanswered decision falls back to a person through `run.issue`; configure that target before adding a decision.

```json
{
  "model": "openrouter/typesafe/jev-1.13",
  "maxCostUsd": "0.001",
  "shadow": true,
  "questions": {
    "act": {
      "type": "choice",
      "criteria": {
        "investigate": "a new failure that a read-only look could explain",
        "file_issue": "a person should decide",
        "ignore": "a known expected spike"
      }
    }
  },
  "act": {"investigate": 0.70, "ignore": 0.90, "otherwise": "file_issue"}
}
```

Place this object at the watch trigger's `decide` key. A separate fresh container makes exactly one classifier call through the same guarded pinned model runtime as a job. It starts no chat agent and loads no extensions. The ordinary job and dollar admissions happen before the call; the runner also checks a conservative per-request bound before dispatch. Free output alone does not establish an exact input-token price. Models with unknown pricing or priced output are refused. Configure credentials for both the investigation provider and the reviewed classifier provider through the ordinary host environment or enabled pi-auth fallback. The worker probes both before any reservation and forwards only those providers' credential variables. A trigger secret or bundle cannot replace the classifier's credential.

The decision sees bounded projected metadata, never samples. Optional `fields` explicitly selects additional bounded scalar fields; treat every selected value as attacker data. The model chooses only reviewed options. The selected option must meet its configured probability threshold; malformed, incomplete or invalid probabilities do not authorize investigation. `ignore` spends only the decision's admitted cost. Failed calls may retain a conservative charge when actual usage is unknown. The decision container and a later investigation have distinct reservations; neither can spend outside its own cap or the shared limits.

The public summary includes reviewed model/question identifiers, the selected choice, probabilities, confidence and cost. Input state belongs only to private evidence. A probability is a model answer, not proof of correctness.

## Trusted tools

A watch investigation may use `decide` with the reviewed classifier. Those calls use its own job reservation and process guard. The tool cannot select a different provider or endpoint.

Configure `run.queryLogs` with reviewed named queries. Each name declares `endpoint`, `query` and optional `credentialEnv`, the name of a credential supplied by the reviewed `run.secrets` or project secret bundle binding. The worker resolves that name before staging the job and constructs a Bearer authorization header. A missing or newline-bearing credential refuses the job; the finding never selects a credential. The tool accepts only a name, never a model-written URL, query or header. It POSTs `{ "query": "the reviewed query" }` to HTTPS, rejects redirects, times out after ten seconds, and accepts at most 65536 response bytes and 100 rows. The endpoint must answer a JSON array or `{ "rows": [...] }`; adapt a backend's native response in a reviewed read-only collector or proxy when necessary. Credentials are resolved host-side and never included in trace entries.

`board_write` proposes plain board data through `/outbox/board.json`. It does not change the adopted board. The worker applies the final schema and size checks, so an invalid proposal preserves the current board.

## Trace privacy and limits

Trusted queries, decisions and board proposals write started/completed/failed entries to the bounded outbox trace. The worker imports them into the finding's private trace. Query text, state, samples and notes are operator only; viewer responses contain only an explicit public summary. Credentials and raw provider error bodies are excluded. Queries made outside trusted tooling are not a supported watch execution path.

The runner trace is capped at 128 entries and 256 KiB. The finding trace retains at most 1000 entries for seven days. These limits can remove evidence; an expired or unavailable trace is not reported as a successful empty investigation. A failed query can leave a started/failed pair without rows. An ignored finding still has a decision summary and trace.

## Board proposals and adoption

The board is inert data drawn by console components. There are six block kinds: number, line, table, note, hypotheses and timeline. Each block has a unique id and traceId provenance. The proposal document is `{ "version": 1, "blocks": [...] }`, at most 16 KiB measured as UTF-8 bytes. Arbitrary HTML, scripts, styles, remote images, query overrides and outside links are not board block schemas.

Jobs propose changes; an operator reviews and adopts them. Private run notes stay with the run. The next investigation receives adopted board data as untrusted input, never the previous transcript or unadopted notes. At most twenty versions/proposals are retained; inactive board data expires with its seven-day store TTL.

Freeze, unfreeze, adopt, revert and clear all use the console's existing preview and Confirm. The preview binds the current version, so a concurrent change refuses rather than silently applying to a different board. Freeze prevents adoption. Revert and clear require an operator just as adoption does; freeze, revert and clear receive destructive-action styling. Each action is audited before mutation and failed mutations get the existing correlated failure audit entry.

Viewers see only approved numeric board data and public pipeline summaries. An operator uses the dedicated private evidence endpoint for query text, decision state and samples. The console never serves agent-written HTML and keeps its existing CSP.
