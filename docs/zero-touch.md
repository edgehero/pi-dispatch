# Zero touch

Open **Runs → Zero touch** to see how often workload runs needed a person, over 7, 30 or 90 days. Projects open to
repositories or local folders. The goal is zero touches, and the 5% marker is a guide rather than permission to act.

A run counts once when a person answers its parked question, decides an approval, reruns a failure or refusal,
changes configuration explicitly because of a refusal, delivers steering, or cancels it while running. Reads,
merges, sandbox use and automatic starts add nothing. The cause chart assigns each touched run to its first
successful intervention; later interventions remain in its history. Jobs removed before their first attempt are
counted separately. Stops whose project or folder was never recorded remain explicitly unattributed in scoped views.

The denominator is distinct workload runs whose records ended in the covered interval. Internal grouping jobs keep
normal history and spend but are excluded from workload rates, so analysing a rate cannot improve it. The Open as
runs links list the touched source runs, with the same window and scope.

## What the numbers can prove

The selected window and covered interval are different when retention, the run mirror, touch tracking or a source
read cannot cover the request. A partial window names its start. Older unknown runs are not presumed untouched;
missing evidence never becomes a zero rate. A window without ended workload runs has no percentage. Weekly points
and changes against the preceding interval are absent when their comparison is not covered.

Tracking begins with this release. Upgrade every worker, receiver, CLI and admin process participating in the fleet
before relying on its coverage. Older clients cannot publish interventions they were never written to record.
`PI_LOG_RETENTION_DAYS` and the mirror's retained count also bound the report. The text-free touch index is bounded to
365 days and 30,000 events even when ordinary history is retained indefinitely; its loss and trimming are partial.

Waiting hours sum the time each parked run waited within the interval. A proven answer uses the service's original
receipt time rather than later worker pickup, so queue delay does not inflate the human wait. Held or refused
answers do not prove a resume. Approval decisions count when a person's decision is accepted; system expiry does
not. The median covers completed waits, and open waits show run links. A 30-day zero-touch project needs complete
coverage, actual workload activity and no outstanding wait; inactivity is not a badge.

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
both providers' normal credentials and declared endpoints as appropriate. No new credential is stored in this file.

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
to the refusal. An unrelated edit has no attribution merely because it followed a refusal.

The fixes log compares occurrences of the same refusal reason or question group over equal elapsed spans before
and after the change. Untouched refusals and unanswered questions still count. It shows workload exposure and
incomplete coverage. No subsequent runs means observing, not proof that a fix worked. Reverted instruction fixes
remain visible as reverted. Viewers see safe change descriptions and counts, without instruction text or actors.

Accounting publication can fail after a successful action. Pending intents and exact-proof repair make that visible
without repeating the action. Read the returned warning, restore the unavailable source and reload; do not repeat an
edit because its metric is pending. Conflicting later edits leave uncertain evidence partial.

## Roles and interaction

Viewers receive rates, counts, causes, streaks and safe fix descriptions. Operators additionally receive question
groups and confirmed actions. A read-only console keeps the reads and suppresses writes. Native disclosures and
window navigation work without JavaScript; writes remain disabled with an explanation. The page uses the console's
normal CSP and theme controls. Standing answers, draft answers and sandbox management belong to the following
features (#772 and #771), and are not active controls on this page.
