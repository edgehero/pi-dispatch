# Model failover

An operator can list models to try on the next queue attempt when a provider is rate limited, out of quota or overloaded. Selection happens at pickup, before credentials are minted, a repository is cloned or budget is reserved. Nothing changes model inside a running attempt.

Add the list to a reviewed trigger file, or change it on the trigger's [console page](console.md#what-a-triggers-jobs-get):

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

Failover opts the job into a narrower execution policy: each attempt may call its selected root model and any explicitly granted `run.auxiliaryModels`, including admitted child calls. Without that separate auxiliary grant the executable list contains only the selected model. Auxiliary panel members must also be in the explicit `models` ceiling and require positive `maxCostUsd`; they do not become root fallback candidates. All declared auxiliary auth and quota routes must pass before the attempt starts ([subscription authentication](subscription-auth.md)).

Each attempt is a container of its own, built for its model. A fallback's API key bound in the trigger's `run.secrets` reaches only the attempts whose model, or an auxiliary model, is on a provider that reads it: the attempt on that fallback spends it, and the primary's attempts, a subscription primary's above all, do not get it, so no tool they run can spend it outside the cost meter. The primary's own key likewise reaches only the primary's attempts. The worker logs `run_secret_withheld` naming the run secret it kept out ([the provider key as a run secret](secrets.md#the-provider-key-as-a-run-secret)).

The worker considers the primary, then the fallbacks in order. Each candidate must exist in the pinned catalog or overlay, have a locally supported cost bound and provider credential, pass egress rules, have endpoint capacity and model-dollar-window room, and be outside cooldown. A candidate with a declared server-side fallback outside its singleton policy is skipped. `pi-messages` routes have no verified local cost bound and are ineligible. The worker log names skipped configured models and fixed reasons, never provider error bodies or credentials.

The image must declare `modelFailover`; an older image is refused before spend as `job-image-model-failover-unsupported`. Rebuild it before enabling the list.

The runner classifies the final provider failure after pi's own retries. pi 1.6.1 retries more failures itself before that (Anthropic's `api_error` while streaming, Cloudflare's 525, a gateway's "provider is temporarily unavailable", OpenRouter's empty answers, "request rate increased too quickly"): each retry is a paid call the meter counts, and one that fails after the turn's tools ran ends the job as `retry-unresumable`, which is not retried, rather than as an infrastructure failure the queue runs again. A 429 with a usable reset becomes `rate-limited`; known quota/spend-limit errors, and 429s without one, become `quota-exhausted`. So do two kinds of spending-limit refusal. A 402 counts only on the apis whose HTTP status the runner observes (anthropic-messages, openai-completions, openai-responses and azure-openai-responses); elsewhere a 402 is the plain infrastructure exit with only what the text patterns read. A 403 counts only in OpenRouter's measured shapes: its refusal for a used-up workspace budget or a key past its limit, on either of its apis, which the runner reads by the sentence that begins OpenRouter's message, as a used-up quota rather than a refused key (`provider-auth-refused`), so the model cools down for six hours and a random pool draws its other models meanwhile. Any other 401 or 403 is read as before. Overload/5xx becomes `overloaded`. Parameter and authentication errors do not authorize switching, and neither does a request that never got an answer from the provider, such as the egress proxy refusing the connection: that is the network, not the model. Amazon Bedrock is the exception: its client reports the proxy's refusal as if Bedrock had answered with that status, so a proxy error there can still cool a Bedrock model. An explicit refusal of the request by Anthropic does not authorize switching either: the runner stops the job as `provider-stop-refusal` ([reasons.md](reasons.md#provider-stop-refusal)), which is not retried, so no other model is tried. Reset visibility depends on the provider adapter: an unavailable reset uses the no-reset policy rather than a guessed time. A ChatGPT subscription past its usage limit refuses inside an HTTP 200 stream; the runner reads the refusal's closed code from that event, never from the sentence pi prints, so it is `quota-exhausted` too ([subscription authentication](subscription-auth.md)).

Cooldowns are shared across workers per exact provider/model. A provider reset is capped at six hours; quota without a reset uses six hours, and rate limit/overload without a reset uses 60 seconds. A later observation cannot shorten a longer existing cooldown. Context overflow does not cool a model globally: that job can choose only a candidate with a known larger context window.

A second attempt may switch only when authenticated runner evidence proves no root tool started and no secondary or child-call uncertainty exists. A crash, missing evidence, an older image or any tool execution prevents cross-model replay. The failed model is skipped on that retry even if its cooldown elapsed during queue backoff. Other jobs can use it once the cooldown expires. Recovery always uses its checkpoint model. The existing queue attempt count and backoff are unchanged.

A job with fallbacks keeps one small hashed marker in Valkey (`dispatch:model-attempt:*`), written before each attempt, naming that attempt's model and whether a retry may switch. It has no expiry while the queue may still retry the job, so a paused or delayed retry cannot lose its replay-safety history. Once the queue says the job finished (it completed, or it failed with no retry left), the marker expires after 32 days, a day longer than the queue keeps a finished forge job, so a retry from the console still finds it. The console's retry takes that expiry off as it puts the job back, so the retried job keeps its marker however long it then waits to start (a paused queue, a busy scope, a hold for a newer release), and its next attempt writes it again, without an expiry. A cancel of a job waiting to start or to retry deletes it, and so does the sweep that takes a recovery off the queue when its host is gone. A run record is never the signal, because it is written before the queue acknowledges the job. If the expiry cannot be set, the worker logs `model_attempt_finish_failed` and the marker stays without one. The queue removes old failed jobs lazily, so one can stay longer than its retention: retried from the console more than 32 days after it failed, it is refused `model-failover-no-candidate`, before anything is spent. So is a console retry whose expiry could not be taken off (Valkey did not answer, or refused) that waits to start until the 32 days are over.

If every otherwise usable candidate is cooling down, has a full model window or has no endpoint slot, the job waits without starting a container. If none is eligible, it refuses with `model-failover-no-candidate`. A retry whose previous attempt's run record a newer pi-dispatch wrote (issue #761), with no attempt marker naming its model, is not refused: this release cannot read that record's evidence, so the job waits with "Queued or configured by a newer pi-dispatch: waits for this host's upgrade" until a host that reads the record takes it, a later record replaces it, or the record ages out of retention (the retry is then judged as one with no record). Only the previous attempt's own record holds it (the same job id and attempt, from no earlier than five minutes before the job was queued, judged by its start, or by its end when it has none): a newer record that an older job left under the same id does not. While it waits, the checks of the model selection it skipped do not run, so a job they would refuse or hold (an invalid fallback list, a local folder that holds the subscription credential store, a subscription check on the chosen model) waits too, until the record is read or gone. A cooldown-store fault retries as infrastructure. Model-window reads guide selection; the later atomic reservation can still refuse if another pickup takes the room first.

The run record carries the actual `provider` and `model`, plus `modelWhy`: `primary`, `fallback-cooldown`, `fallback-window`, `fallback-unavailable` or `fallback-context`. A classified terminal error adds the closed `providerFailure` detail, and a provider error the runner reported adds `providerMessage`: what the provider said, at most 500 characters, with every secret value the job held taken out. The worker log has the same as a `provider_error` line. `pi-dispatch doctor` shows configured models cooling down, their cause and reset time. The console's Doctor panel shows the same published warnings and how old the observation is.

Jobs without `fallbackModels` keep their existing model-selection behavior. An explicit subscription binding
adds its separate authentication and account-quota admission even without fallbacks. Unbound providers retain
the existing API-key path; portfolio weights do not choose models. See [subscription authentication](subscription-auth.md).

Subscription account windows are separate from the physical model cooldown above. A known weekly reset is
preserved for the full week. Exhaustion with no reset persists until newer evidence or a person's trial (one job
that reaches the provider), or, when a provider's refusal recorded it, until a retest the provider answers: one job
tries the connection six hours after the newest refusal, and its exit clears the refusal once the provider has
answered it; the six-hour model timeout alone does not clear it. While it lasts, every openai model on that connection
is blocked, not only the one that was refused, because the limit belongs to the account. A fallback on another
subscription runs the retry; a fallback billed by an API key behind a subscription primary is skipped
(`auth-mixed-billing`), so such a trigger waits for the limit instead. A random pool draws again among its
other candidates, by their weights where the pool sets them. The reviewed fallback order still applies, and each
candidate must have authorized authentication and pass all ordinary admission gates. Candidate checks do not
consume a trial or rotate accounts. Nothing switches credentials inside a running attempt.

## Models in the console

**More → Models** shows configured cooldowns with their fixed cause and UTC end, model-window usage and
recent fallback runs in sentences. It reads the configured failover keys, never scans arbitrary model keys.
A missing observation is unknown, not proof that a model is ready or a window is empty.

The next-candidate explanation is advisory: it reflects the displayed price/cooldown evidence and reserves
nothing. Credentials, egress, per-job dollar bounds, windows and endpoint slots are checked again at pickup.
A role with no fallback may still be used by a trigger with its own fallback list; the page distinguishes
those effective policies. Jobs with no effective fallback start on their primary and do not consult cooldowns.
Waiting cooldown/window jobs link to Overview. Run detail uses the same model-choice and provider-failure
words. A provider's message is kept only in the run record and the worker log, never in a comment, on the console's
pages or in what the console's tools hand a model; a cooldown start time is not stored or invented.
