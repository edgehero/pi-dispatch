# Portfolio manager example

A flow that plans the week's budget split between your projects, then reports what it asked for. It runs
as a weekly cron job with `"portfolio": true`. The worker gives it a snapshot of the budget
(`/job/portfolio.json`), the flow writes a priorities plan (`/outbox/priorities.json`), and the worker
decides after the job ends whether the plan applies. The full guide is
[`docs/portfolio-manager.md`](../../docs/portfolio-manager.md).

| File | What it is |
|---|---|
| `priorities.md` | your goals per project: the file the flow reads as your instructions |
| `triggers.portfolio.example.json` | the weekly cron entry |
| `plan.fixture.json` | a fixed plan for the zero spend test |
| `.pi/skills/portfolio-manager/SKILL.md` | the flow |
| `.pi/skills/portfolio-manager/report.mjs` | the report script (Node only, no dependencies) |
| `.pi/skills/portfolio-fixture/SKILL.md` | a test flow that sends `plan.fixture.json` with no judgement |

## Set it up

1. Copy this folder to a folder of its own, and make it a git repository with a commit. A local job needs
   one, and the flow is read from the commit:

   ```bash
   cp -R examples/portfolio-manager ~/pm
   cd ~/pm && git init && git add -A && git commit -m init
   ```

2. Put that folder in a project with a floor, for example `ops`, in `projects.json` and in your envelope.
   The manager's own job pays from that share. With no project it pays from `_other`, and a plan that
   gives `_other` nothing refuses the manager itself as `allocation-cap`.
3. Edit `priorities.md`: one section per project id in your envelope, `_other` included. Commit.
4. Add the entry from `triggers.portfolio.example.json` to your triggers file, with `folder` set to the
   absolute path of your copy. Keep only the secret of the channel you use, and declare the resolver that
   reads it (`PI_SECRET_PROFILES=default:/path/to/resolver.sh`, see [`docs/secrets.md`](../../docs/secrets.md)).
5. Add the hosts the job talks to in `egress-allowlist.conf`: `api.github.com` for the GitHub channel, or
   your webhook's host.

The entry does not set `"github": true`, on purpose: that would hand the deployment's own GitHub
credential to a job that reads issue text. The report uses a fine grained token of its own
(`REPORT_GH_TOKEN`), with Issues read on the project repos and Issues write on one tracking repo.

## Test it with zero spend

Point the trigger at a local model with a nonzero price (so the meter and the caps run as for a paid
model), and set `"flow": "portfolio-fixture"`. Then run it now instead of waiting for Monday:

```bash
pi-dispatch run --trigger pm-weekly
```

The worker logs `plan_collected` with outcome `applied`, and the panel's ALLOCATION view (`b`) shows the
fixture's split with writer `portfolio-job`. A small local model may need the flow's one command in the task
as well. Switch `"flow"` back to `portfolio-manager` for real runs. The steps, with the numbers to expect,
are in the guide.

The job log does not hold what the script printed. To read the report, run the script with `--dry-run` on
the files the job left in its retained sandbox, `PI_SANDBOX_DIR/<run>` (the job id with each `:` written as
`_`; `PI_SANDBOX_DIR` defaults to `<PI_JOBS_DIR>/sandboxes`):

```bash
node .pi/skills/portfolio-manager/report.mjs --dry-run --priorities priorities.md \
  --snapshot "$PI_SANDBOX_DIR/<run>/portfolio.json" --plan "$PI_SANDBOX_DIR/<run>/outbox/priorities.json"
```
