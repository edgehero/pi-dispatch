# Zero touch

Open **Runs → Zero touch** to see how often workload runs needed a person, over 7, 30 or 90 days. Projects open to
repositories or local folders. The goal is zero touches, and the 5% marker is a guide rather than permission to act.

A run counts once when a person answers its parked question, decides an approval, reruns a failure or refusal,
changes configuration explicitly because of a refusal, delivers steering, or cancels it while running. Reads,
merges, sandbox use and automatic starts add nothing. The cause chart assigns each touched run to its first
successful intervention; later interventions remain in its history. Jobs removed before their first attempt are
counted separately. Stops whose project or folder was never recorded remain explicitly unattributed in scoped views.

A touch counts against a run only from the moment the run's job was queued (its record's `jobCreatedAt`, less five
minutes for clocks that differ between machines). A run id can come back, when a lost queue is followed by a webhook
redelivered by hand, and the older job's touches under that id are not the new run's, nor is its approval's expiry or
revocation the end of the new run's wait. Later touches still count: an answer or an approval after the run ended, and
anything during an earlier attempt of the same job. A record written before this field existed sets no such start.
A repository's and a project's streak still count every touch in them.

The denominator is distinct workload runs whose records ended in the covered interval. Internal grouping jobs keep
normal history and spend but, like internal answer-draft jobs, are excluded from workload rates, so analysing a rate cannot improve it. The Open as
runs links list the touched source runs, with the same window and scope.

## What the numbers can prove

The selected window and covered interval are different when retention, the run mirror, touch tracking or a source
read cannot cover the request. A partial window names its start. Older unknown runs are not presumed untouched;
missing evidence never becomes a zero rate. A window without ended workload runs has no percentage. Weekly points
and changes against the preceding interval are absent when their comparison is not covered.

Until a worker has started touch tracking, the page says once that tracking has not started and shows no rate, count
or streak: there is no interval to measure yet, and nothing failed. "Zero touch could not be read" is kept for
evidence that was lost or could not be read. When the page's own read fails, it says so and the console's log has a
line with the error's code.

Tracking begins with this release. Upgrade every worker, receiver, CLI and admin process participating in the fleet
before relying on its coverage ([the order](upgrading.md#the-order)). Older clients cannot publish interventions they
were never written to record.
`PI_LOG_RETENTION_DAYS` and the mirror's retained count also bound the report. Retained older parks still contribute
current waiting time. With unlimited local retention, this on-demand reader scans the retained history to find them. The text-free touch index is bounded to
365 days and 30,000 events even when ordinary history is retained indefinitely; its loss and trimming are partial.

Waiting hours sum the time each parked run waited within the interval. A proven answer uses the service's original
receipt time rather than later worker pickup, so queue delay does not inflate the human wait. Held or refused
answers do not prove a resume. Approval decisions count when a person's decision is accepted; system expiry does
not. The median covers completed waits, and open waits show run links. A 30-day zero-touch project needs complete
coverage, actual workload activity and no outstanding wait; inactivity is not a badge.

Authenticated approval expiry and trigger-policy revocation end the corresponding wait without recording a human
touch. Their terminal times bound waiting hours; they do not enter the median of human answer times.

A retained park can outlive the touch history that proved its answer. When a park predates that history and no
terminal answer survives in the index or records, waiting hours and the pending count say they are not known.
Affected project and repository streaks also remain unknown. This separate waiting-history warning preserves a
current touch rate whose own ended-run interval is still covered. Restoring retained answer evidence resolves it.

## Group repeated questions

Question groups are visible only to operators. An operator names a group, and a decision model assigns questions to
it by meaning. The page carries names, counts and run links, never question text or a model-written summary. Read
the question on its operator-only run page.

Capture is opt-in. Add a reviewed `zeroTouch` section beside `triggers` in the deployment's `triggers.json`:

```json
{
  "triggers": [],
  "zeroTouch": {
    "capture": true,
    "model": "your-provider/your-classifier",
    "maxCostUsd": "0.05",
    "confidence": 0.9,
    "names": {}
  }
}
```

Use a typed classifier model available to the pinned runtime, with explicit finite input pricing, zero output
pricing and a known context window. The configured cap must cover its conservative full-context input bound. The
ordinary deployment text model remains the primary model for admission; no text-agent session executes. Configure
both providers' normal credentials and declared endpoints as appropriate: the host's environment or pi's `auth.json`.
A key a trigger declares in its `run.secrets` does not reach a grouping job. To give the grouping job keys of its own,
add `secrets` (and `secretsProfile`) to this section as on a trigger: a provider's API-key variable mapped to a
reference your resolver reads, never the key itself. A name that is not a provider's API-key variable (an OAuth or
bearer variable, a typo, an unrelated variable) is refused when the file loads. The job receives the keys its
classifier's provider or the deployment's default provider (its primary model's, known only when the job starts)
reads; the worker withholds another provider's key and logs `declared_key_withheld`. A declared key is that model's
only key: the host's key for that provider never reaches the job, and an empty value refuses it before anything
spends. The file needs triggers file version 12, and a grouping queued before a change to these fields is refused as
`question-group-config-changed`. The rules are those of [secrets](secrets.md).

After capture, **Group question** previews the classifier and cap. Confirm queues an ordinary budgeted job. Page
loads make no provider calls. The container gets only frozen private input, no Valkey credential or writable forge
integration. Output is a closed slot and confidence; invalid, uncertain or stale output stays explicitly unassigned.
A pending result can be deliberately retried through another paid preview, which warns that it may pay again. No
collection failure automatically buys another call.

The separate private corpus is redacted with the job's credential redactor before storage. Each excerpt is at most
16 KiB, the corpus at most 1,000 entries, and each input at most 256 KiB. A repository can compare at most 14 existing
exemplars plus the new/unassigned choices. Private retention is the shorter of history retention and 90 days;
retention zero still means 90 days here. Expired exemplars, incomplete context, limits and missing sources are named
rather than treated as evidence for a new group. Safe assignment metadata has its own bounded retention. Turning
capture off stops new excerpts and calls; it does not instantly erase previously retained telemetry.

## Fix a recurring cause

From a question group, **Add to instructions** previews a sentence appended to its source trigger's instructions.
Confirm applies precisely that diff, or refuses if the trigger changed. It requires the retained source job to prove
the current trigger still matches. Instructions are limited to 2,000 characters in total and this write is available
only in the operator console, never through model tools. Cron instructions belong in the task, so that action says
why it is unavailable there. Undo restores the previous instructions only while the exact trigger still matches.

From a refusal's run page, **Fix configuration** opens Configuration with that source explicitly attached. Navigation
within Configuration retains the context. Normal preview and Confirm apply the selected write and record its link
to the refusal. An unrelated edit has no attribution merely because it followed a refusal. A budget change (the
envelope, a priorities plan, an allocation revert) is a write to Valkey and not to a configuration file, so it is
never recorded as a fix. What records a fix never answers in the change's place: a change that was refused or that
failed says so in its own words.

The fixes log compares occurrences of the same refusal reason or question group over equal elapsed spans before
and after the change. Untouched refusals and unanswered questions still count. It shows workload exposure and
incomplete coverage. No subsequent runs means observing, not proof that a fix worked. Reverted instruction fixes
remain visible as reverted. Viewers see safe change descriptions and counts, without instruction text or actors.

Accounting publication can fail after a successful action. Pending intents and exact-proof settling make that visible
without repeating the action. Read the returned warning, restore the unavailable source and settle it from the Zero
touch page; do not repeat an edit because its metric is pending. Conflicting later edits leave uncertain evidence
partial.

Opening the page never settles anything (2026-11-25, #1076): a page view is a read. The page counts what waits, and an
operator settles it with **Preview settling** and **Confirm** on a writable console. A settle records an action that
ran and whose touch was not recorded, once, and completes a fix whose change landed and whose completion was lost.
It never runs an action again, and settling twice records nothing twice. The worker's daily sweep also records
unfinished touches on a host that shares the logs folder. An action interrupted before it said whether it ran stays
unknown: no settle can prove it, and while it is pending the touch rate is not shown.

A change that was made is never lost from the fix history: when its completion could not be written, the page says
"1 fix is waiting to be settled", and a settle completes it as soon as its file shows the change, whatever other fix
wrote the same bytes. A change that was REFUSED can leave its accounting open when Valkey did not answer. While such
an entry is open and its file does not show the change, the page says "Fix history is incomplete: the accounting of 1
change did not finish and its file does not show it, so no settle records it", with how long its record lives at most
(the history's retention). If the same bytes are written later, by the same change made again or by hand, a settle
completes the open entry too, so one change can read as two fixes; that needs Valkey silent exactly at a refusal's
accounting.

## Roles and interaction

Viewers receive rates, counts, causes, streaks and safe fix descriptions. Operators additionally receive question
groups and confirmed actions. A read-only console keeps the reads and suppresses writes. Native disclosures and
window navigation work without JavaScript; writes remain disabled with an explanation. The page uses the console's
normal CSP and theme controls. **Answered from a draft** shows distinct workload runs actually answered from a
person-confirmed draft, edited or as drafted, within the same covered interval and project/repository selection.
Each remains a human touch. Duplicate deliveries and record/index copies count once; offered, unsent, refused
answers and internal draft jobs add none. Partial history labels the retained count; unavailable evidence is not zero.
Answer rules, standing answers and sending are managed on Parked. Sandbox management stays on its own Runs tab;
this count exposes no draft text or answer controls.
