The Parked page with the Approvals tab (#649): the agent asks permission for a named action, the run parks, and a person approves, declines with a reason or asks a question back.

## How a person uses it
- The request card names the run, the gate and the action in one line ("gh-7b21 asks to push to main"), with the project, target, trigger author and how long it has waited. A chip shows when an unanswered gate declines itself.
- The gate block lists:
  - the action and its arguments (branch, commits, files with line counts);
  - the agent's own summary, set apart as untrusted text;
  - the risk line, which says whether the worker enforces the gate or it is advisory.
- **Approve push** is the primary action. **Decline** is a danger outline; here it is expanded with a reason field, and the danger preview says the reason goes back to the agent as the result of `request_approval`, not as an error. **Ask a question back** keeps the run parked.
- The side column lists what else waits (a budget-raise request in compact form, and the parked question). It also shows recent decisions with who decided and when.

## Panels
`p-approval`, `p-others`, `p-history`.

## The server provides
Per request: run, gate name and its declared kind (worker-enforced or advisory), action and arguments, the agent's summary (untrusted, escaped), the trigger author, asked-at time, the optional `gateTimeout`, and who may decide. Plus recent decisions from the audit log.

## Why it works this way
- A trigger declares its gates (`run.gates`). When the agent asks, the run parks like a question.
- Push to the default branch, pull request and budget raise are enforced by the worker. Deploy gates are advisory to the skill.
- Only people who pass the trigger's author gate can decide.

## Fixture note
All approval content is sample, because approval gates are planned for 5.0.0: gh-7b21, gh-3c90, gh-71aa, gh-0c4e, gh-55d2, the commits, files, summary, reason and @rob as trigger author. gh-2f6a and its question count come from the fixture. The Parked count in the nav is 3: 1 question and 2 approvals.
