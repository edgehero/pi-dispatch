# Approval gates

A gate lets a resumable forge flow ask a person to approve a named action. The container ends while the person decides;
the saved conversation continues in a fresh container. There is no model spend while it is parked.

Configure the initiating trigger and its comment trigger with matching gate declarations, for example:

```json
{
  "on": { "type": "comment", "phrase": "@pi" },
  "run": {
    "kind": "github",
    "flow": "fix",
    "resume": true,
    "gates": ["budget-raise", "deploy:staging"],
    "maxCostUsd": "2",
    "gateBudgetRaiseUsd": "5",
    "gateTimeout": 7
  }
}
```

The agent first posts its summary on the issue or pull request, then calls
`request_approval({action: "deploy:staging", summary: "..."})` as its only tool call. The worker saves the conversation,
publishes a durable request, and marks issues with `pi-awaiting-approval` alongside `pi-awaiting-input`.

An authorized forge reply `/approve` approves; `/decline` with an optional reason declines. Other text asks a question
and resumes the agent with a question result. On pull requests, keep the configured comment phrase before the command.
A question consumes this request; the agent can answer and request approval again. Console operators can use the
parked inbox or run chat, and terminal `/dispatch chat` accepts the same commands. Viewer accounts cannot decide.

`budget-raise` is worker-enforced: approval changes the trigger cap to the declared absolute amount for one resumed
container. It cannot exceed the live deployment cap or bypass deployment, repository, project or model spending
windows. Decline, question and expiry grant no increase. Each container reserves and settles its own spending.

Other accepted action names are advisory instructions to the flow or skill. They do not remove shell commands,
credentials or deployment access from the container. Push, default-branch push and PR-opening built-ins are refused;
the current credential modes cannot enforce those gates. Branch protection remains required. Per-gate stricter author
lists are not implemented. Gates require a resumable forge flow without commands, replicas, recovery or forks, and an
image declaring both `approvalGates` and `exitAuth`.

`gateTimeout` optionally declares 1 to 365 days. The session host checks once a minute and records an unanswered
request as declined, then queues its continuation. Host downtime delays processing. Queue failures retain the decline
for retry. The fixed expiry comment is attempted once; a forge failure is logged. Expiry never deletes the decision. Revoked declarations retire requests without a model call, including after restart. Finished request data is retained for 32 days.

In a fleet, declare `PI_WORKER_NAME` on every worker. Replies then route to the host queue that owns the saved session; another host refuses the continuation before spending.

Replies are durably queued first; the session host accepts the first decision atomically at pickup after checking both the initiating and reply declarations. The deadline is judged when the worker accepts the decision, so a reply queued before the deadline but picked up after it declines. The first accepted decision wins. Replies and console previews bind to one request and cannot approve a later gate.
Restart and infrastructure retry preserve the decision and bind it to the exact saved conversation bytes. Exhausting infrastructure retries closes the request; a new authorized run must ask for approval again. A policy refusal closes its continuation without retry;
check its reason and start a new authorized run if needed. An expired, missing, changed or compacted conversation cannot
receive approval by starting a fresh session. If publication fails after a completed container, its work stays saved,
the issue gets an actionable refusal, and no approval is armed. Repair the stores before starting another run.

Decision metadata alone crosses the container environment. Accepted human text is read from the existing read-only event input, including on OpenShell, whose exec arguments may be logged.

Public records contain request/action and decision identifiers, hashed decider IDs and time. Summaries, questions and
human reasons stay in the private transcript/answer data and never become run-record metadata.

If terminal request cleanup cannot reach Valkey, the worker logs `approval_terminal_finish_failed`. Restore Valkey and retry the existing failed job before removing it; a new reply cannot take over another job's claim.
