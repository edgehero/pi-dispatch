# Model failover

An operator can list models to try on the next queue attempt when a provider is rate limited, out of quota or overloaded. Selection happens at pickup, before credentials are minted, a repository is cloned or budget is reserved. Nothing changes model inside a running attempt.

Add the list to a reviewed trigger file:

```json
{
  "on": { "type": "label", "any": ["pi:fix"] },
  "run": {
    "kind": "github",
    "flow": "fix",
    "provider": "anthropic",
    "model": "claude-sonnet-5-5",
    "models": ["anthropic/claude-sonnet-5-5", "openai/gpt-4o"],
    "fallbackModels": ["openai/gpt-4o"]
  }
}
```

Every fallback must be on `run.models`, or `PI_ALLOWED_MODELS` if the trigger has no list. Lists contain 1 to 16 distinct `provider/model` strings, in preference order. Matching keeps the catalog's case. No model-callable tool can set or remove `fallbackModels`, including behind a confirmation. An unrelated trigger edit preserves it.

Failover opts the job into a narrower execution policy: each attempt may call **only its selected model**, including child processes. A flow that intentionally calls several models should keep its existing configuration without `fallbackModels`.

The worker considers the primary, then the fallbacks in order. Each candidate must exist in the pinned catalog or overlay, have a locally supported cost bound and provider credential, pass egress rules, have endpoint capacity and model-dollar-window room, and be outside cooldown. A candidate with a declared server-side fallback outside its singleton policy is skipped. `pi-messages` routes have no verified local cost bound and are ineligible. The worker log names skipped configured models and fixed reasons, never provider error bodies or credentials.

The image must declare `modelFailover`; an older image is refused before spend as `job-image-model-failover-unsupported`. Rebuild it before enabling the list.

The runner classifies the final provider failure after pi's own retries. A 429 with a usable reset becomes `rate-limited`; known quota/spend-limit errors, and 429s without one, become `quota-exhausted`. Overload/5xx becomes `overloaded`. Parameter and authentication errors do not authorize switching. Reset visibility depends on the provider adapter: an unavailable reset uses the no-reset policy rather than a guessed time.

Cooldowns are shared across workers per exact provider/model. A provider reset is capped at six hours; quota without a reset uses six hours, and rate limit/overload without a reset uses 60 seconds. A later observation cannot shorten a longer existing cooldown. Context overflow does not cool a model globally: that job can choose only a candidate with a known larger context window.

A second attempt may switch only when authenticated runner evidence proves no root tool started and no secondary or child-call uncertainty exists. A crash, missing evidence, an older image or any tool execution prevents cross-model replay. The failed model is skipped on that retry even if its cooldown elapsed during queue backoff. Other jobs can use it once the cooldown expires. Recovery always uses its checkpoint model. The existing queue attempt count and backoff are unchanged. Small hashed attempt markers are retained without expiry so a paused retry cannot lose its replay-safety history; removing them requires queue-removal-aware cleanup, not deleting them when a run record is written.

If every otherwise usable candidate is cooling down, has a full model window or has no endpoint slot, the job waits without starting a container. If none is eligible, it refuses with `model-failover-no-candidate`. A cooldown-store fault retries as infrastructure. Model-window reads guide selection; the later atomic reservation can still refuse if another pickup takes the room first.

The run record carries the actual `provider` and `model`, plus `modelWhy`: `primary`, `fallback-cooldown`, `fallback-window`, `fallback-unavailable` or `fallback-context`. A classified terminal error adds only the closed `providerFailure` detail. `pi-dispatch doctor` shows configured models cooling down, their cause and reset time. The console's Doctor panel shows the same published warnings and how old the observation is.

Jobs without `fallbackModels` keep their existing behavior. Subscription logins remain refused, and portfolio weights do not choose models.

## Models in the console

**More → Models** shows configured cooldowns with their fixed cause and UTC end, model-window usage and
recent fallback runs in sentences. It reads the configured failover keys, never scans arbitrary model keys.
A missing observation is unknown, not proof that a model is ready or a window is empty.

The next-candidate explanation is advisory: it reflects the displayed price/cooldown evidence and reserves
nothing. Credentials, egress, per-job dollar bounds, windows and endpoint slots are checked again at pickup.
A role with no fallback may still be used by a trigger with its own fallback list; the page distinguishes
those effective policies. Jobs with no effective fallback start on their primary and do not consult cooldowns.
Waiting cooldown/window jobs link to Overview. Run detail uses the same model-choice and provider-failure
words. Provider error bodies and a cooldown start time are not stored or invented.
