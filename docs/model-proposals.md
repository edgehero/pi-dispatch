# Model proposals

Model proposals inform the operator. They never change a role, endpoint, credential or job.

The pi-bump draft pull request reports added, removed and repriced chat models from both exact npm
artifacts. Its public scope is `.github/model-proposals.json`: providers, reference dollar caps and an
output-token allowance. These are reference inputs, not a deployment's real limits. The first-call
number uses the runner's cost guard with an empty-text context. Real prompts, images, thinking and
options can increase it. Unknown bounds are reported as unboundable. A failed catalog download or
verification is explicitly reported as missing evidence in the draft.

Catalog bytes are downloaded from npm, checked against the registry's SHA-512 integrity, decompressed
in memory and parsed only at the fixed JSON catalog paths. Candidate JavaScript is never imported or
executed, and no archive file is written to the checkout. Both downloads and decompression are bounded.

## Doctor lifecycle checks

Doctor does no lifecycle network requests by default. To opt in, create `model-proposals.json` in the
deployment folder:

```json
{
  "version": 1,
  "lifecycleProviders": ["anthropic", "openai"],
  "proxyUrl": "http://127.0.0.1:3128",
  "noticeDays": 90,
  "replacements": {
    "openai/old-model": "openai/provider-stated-replacement"
  }
}
```

The proxy must be reachable from the doctor host and enforce the deployment's egress rules. Doctor
also checks `egress-allowlist.conf` before fetching. Each provider needs its API key in the service
environment (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). No credential is printed. Requests go to the
fixed provider Models API over TLS through the declared proxy, with redirects refused, a five-second
timeout and a one-MiB response limit. There is no direct fallback. An incomplete paginated catalog or
failed request produces a warning, never a claim that models are current.

For each mapped role, doctor warns about deprecation or a retirement date inside the notice window.
The worker's ordinary daily doctor run repeats the warning. `replacements` contains operator-verified
provider recommendations; doctor never guesses a replacement. Anthropic's provider-declared model
line and release dates can identify a newer active sibling. No sibling is inferred from an ID's spelling.
Claude requests explicitly include active, deprecated and retired models, so a mapped model's warning
continues after retirement. Newer-sibling and cheaper-route information rows appear in the doctor CLI.
Published doctor results omit successful-check labels; retirement warnings remain visible there.

The adapters follow the provider references:
[Claude Models API](https://platform.claude.com/docs/en/api/models/list) (`lifecycle`, `line`,
`created_at`, `retires_at`) and [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list)
(`shutdown_date`). A retirement date is a schedule, not proof that retirement has already occurred.
The lifecycle query uses the provider SDK's
[bracket-array encoding](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/internal/utils/query.ts).

## Declared cheaper routes

To compare an equivalent model on an endpoint already declared in `model-endpoints.json`, add a route
declaration to the same file:

```json
{
  "version": 1,
  "routes": [
    { "model": "anthropic/claude-sonnet-5-5", "alternative": "my-gateway/claude-sonnet-5-5" }
  ]
}
```

This explicitly declares equivalence; matching model names alone proves nothing. The source must
appear in the current role map. The alternative must be present in the overlay `models.json`, resolve
to a declared endpoint and have recorded prices. Doctor proposes it only when all four base rates are
no higher and at least one is lower. Tiered or unknown rates produce no cheaper claim. Source prices
come from the overlay or the pinned catalog. Operator-recorded gateway prices are declarations, not
live quotes or measured savings. Run a capped canary before editing the role map.

## Proposals in Models

**More → Models** reads the doctor results each host already published. Loading or reloading the page makes
no lifecycle request. Explicitly typed proposal checks retain bounded redacted labels even when successful;
other successful doctor labels remain private. The read-only model tool receives only typed proposal facts,
not those labels. Missing, stale or older evidence is not a claim that no new model exists.

Retained canary comparisons appear beside proposals. Adopt opens the ordinary role-edit form, requires an
explicit scope and carries the comparison identity and digest into a new preview. The server rechecks the
comparison and repeats its observed numbers before confirmation. Neither opening the form nor confirming
the map edit starts a canary or any other run. There is no proposal date or Dismiss action because no proposal
store exists. See [canary.md](canary.md) for the measured comparison and host command.
