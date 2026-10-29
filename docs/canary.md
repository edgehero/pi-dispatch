# Model-role canaries

`pi-dispatch canary --role editor --model anthropic/<model-id> --flow edit --cap-usd 1`
replays recent completed jobs whose main session used the named role and flow. It prints each original
run beside its candidate run, their recorded cost and outcome, and a link to the console's what-if
estimate. Add `--count 1` through `--count 10` (default 3), or `--json` for the report as JSON.

The candidate must be a chat model in the pinned pi catalog. This command does not change the reviewed
role map. A completed result means the flow completed under the candidate; it does not establish that
its patch is correct or better. Compare the work and use your repository's checks before adopting a
candidate. What-if remains a price estimate, separate from the paid canary's observed results.

The experiment divides its cap between the selected jobs before starting. Each job also obeys the
deployment's smaller per-job cap and reserves against the real deployment job-count and dollar windows.
Token accounting uses the ordinary runner and worker ledgers. Missing or incomplete usage never buys
another replay: the experiment does not recycle a reported saving into extra spending. A candidate whose
first call exceeds its share is refused without making that call.

## Retained sources

Run the command on the host retaining the originals, within seven days of their completion and within
their sandbox retention window. Enable `PI_SANDBOX_RETENTION_HOURS` before producing the original runs.
The source needs its original read-only prompt, event, role snapshot and a host-written base commit in
its sandbox manifest. Older retained runs without `baseSha` are refused; run the flow again after updating.
The command never reconstructs private task text from the PII-free run record.

Each replay checks out that base into a fresh disposable repository. It reads ordinary source objects,
never the original repository's git configuration, hooks, remotes, edits or credentials. Sources with
object-store alternates or links are refused. The original workspace and run record remain unchanged.
Every new run record carries its original run ID, role and candidate model as bounded lineage.

## Enforced execution boundary

The supported execution venue is local Docker under a non-root account. A dedicated, pinned proxy
allows TLS connections only to the chosen first-party Anthropic or OpenAI API host; direct outbound
connections and forge hosts are blocked. Gateways, custom endpoints and role snapshots needing another
provider are refused because this boundary cannot establish their downstream access. The proxy image
must already be available locally, as must a job image declaring cost caps, model policy, model roles,
arbitrary non-root UID support and authenticated exit reporting. Run `docker pull` for the pinned proxy from `deploy/docker-compose.yml`
and rebuild the job image before the first experiment.

The container receives only its provider credential. It gets no forge token, operator overlay, staged
packages, secret bundle, MCP server, shared session or outbox. The worker has no publication, comment or
child-queue collaborator in this path. Shell commands, extensions and child processes share the same
restricted network and disposable workspace; no prompt instruction is relied on to prevent a push or
comment. Original runs depending on a previous session, secrets, recovery or a fork are refused.

Deployments with an allocation envelope, scoped limits, scoped pause windows, host-capacity budgets or another venue are
refused before spending, because this command does not implement their admission rules. A paused
deployment refuses new experiments; a pause noticed during a replay stops its container. Each replay
also has a thirty-minute timeout. Failed cleanup names the remaining Docker resources and fails the
command so the operator can remove them before another experiment.

The command takes a renewable deployment lease before checking that every shared and host queue has
zero active jobs. Ordinary workers defer new starts while this lease is held, so the experiment cannot
run alongside ordinary jobs or another canary. Losing the lease stops the current replay and prevents
the remaining ones from starting. It never pauses or resumes the operator's queues itself.

The flow must be present in the retained base repository's `.pi/skills/`. An injected or overlay-only
flow is refused before the first paid replay. Other roles retain their original snapshot mapping; the
candidate replaces only the role whose main-session runs were selected.

Upgrade every queue consumer before running a canary, and keep legacy worker builds stopped throughout the experiment. The exclusive admission lease is honored by this implementation; older workers do not check it. The command takes the lease before checking all discovered active lists, and ordinary upgraded workers defer before paid work. It stops candidate runs on lost lease ownership. The usual lease residual remains: a control process frozen beyond its lease lifetime cannot stop its container until it resumes.
