<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/banner.png?v=0.5.0" alt="pi-dispatch — run the pi coding agent as a self-hosted service" width="880">
</p>

# pi-dispatch — run the pi coding agent as a self-hosted service

**[pi](https://github.com/earendil-works/pi) is a superb coding agent — but it has no job queue, no spend limit, and, by its own README, no permission system.** pi-dispatch is the operational layer that adds exactly those, so you can run pi **unattended and safely**: on a cron schedule, on your repo's GitHub issues and PRs, or straight from the CLI — every job in an isolated container, with spend bounded *before* a single token is spent.

> This npm package — **`@edgehero/pi-dispatch-admin`** — is the **operator console** (a pi extension). The queue, worker, container image, and GitHub receiver that make up the service live in the [main repo](https://github.com/edgehero/pi-dispatch); install this to **drive** a deployment, and get the whole thing there.

## How it works

Every trigger produces the same job, through the same path — one queue, one container, one budget:

```
   CLI  ·  cron  ·  GitHub issue / PR
                │  enqueue
                ▼
        Valkey + BullMQ            durable queue — survives reboots, absorbs bursts
                │
                ▼
     under the daily cap +         ── if not: refused here, before any spend
       per-job turn budget?
                │  yes
                ▼
        docker run --rm            one ephemeral container per job:
   --cap-drop=ALL · non-root       --no-new-privileges · /job mounted read-only
                │
                ▼
     pi + your .pi/skills          edits your code in place, opens a PR, comments back
```

- **The container is the boundary.** pi ships no permission system, so every job runs `--cap-drop=ALL`, non-root, ephemeral, with its instructions mounted read-only. That *is* the missing permission system — enforced by Docker, not hoped for.
- **Spend is bounded before tokens.** A per-job turn budget plus daily / weekly / monthly caps, checked *before* a container starts. A runaway or a junk trigger costs you a refusal, not a surprise bill.
- **Three triggers, one job.** A CLI command, a cron schedule, or a GitHub issue/PR — same queue, same box, same budget. Cron is the unattended one: recurring work on your own hardware, in an image you control — one per deployment, or one per trigger.
- **Your image, your tools.** Bake a project's toolchain into the Dockerfile; it ships **Playwright + Chromium**, so a flow can build a frontend, screenshot it, and iterate on the rendered result.

## The console — `/dispatch`

This extension puts a live TUI over the whole deployment in one command:

<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/dispatch-dashboard.png?v=0.5.0" alt="The /dispatch panel: status, spend meters, triggers, runs, and settings" width="820">
</p>

- **Status & spend.** Queue and worker state, day/week/month **spend meters** + a daily token counter, and a run-history table with per-job token & cost.
- **Costs, analyzed honestly.** A verdict-first **COSTS view** (`c`): spend per flow/model/day over the retention window, what each declared subscription actually saves against API rates, amortized $/run, and a keyboard **what-if** that re-prices a flow's recorded token profile under another model. Every dollar carries its class — a plan-covered run never renders as $0.00, an estimate is always marked `~ est.`, and a quota no vendor discloses never grows an invented burn-down. Also plain: `/dispatch costs [7d|30d|mtd]` and a `dispatch_costs` tool whose JSON marks every value the same way.

<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/costs-view.png?v=0.5.0" alt="The COSTS view: per-plan verdicts against API rates, a daily spend sparkline, per-flow spend with API-equivalents, and subscription amortization" width="820">
</p>
- **Triggers, editable live.** cron / label / comment / pull_request, with colored drill-ins showing *what fires* each one, *what it runs*, and its *trust model* — added, edited, and deleted without a restart.
- **You can see which triggers run third-party code.** A trigger loads the pi packages you pinned into your global overlay **unless** it carries `run.packages: false`, so the ones that do get a **`[packages]`** badge in the trigger list, and their **trust model** names the staged `name@version` set plus the one-line consequence — third-party code, on adversarial input, with open network egress. Declining is deliberately *not* a panel action: it stays an edit to the reviewed `triggers.json`, which neither the console nor a model-callable tool will make for you.
- **You can see which image each trigger runs.** A trigger may name its own container image with `run.image` (absent = the deployment default), and the trigger list shows the tag while the drill-in states it either way — because which image a job runs *is* which code it runs. Like `packages`, it is display-only: naming an image stays an edit to the reviewed `triggers.json`, which neither the console nor a model-callable tool will make for you.
- **Quiet hours.** Scheduled pause windows per folder or repo: defer a scope's runs **between certain times** — recurring daily, weekday- and date-bounded, timezone-aware — and resume automatically. Deferred, never dropped, at zero budget cost.
- **AI-operable, with a human gate.** Model-callable tools let an agent change limits and manage triggers and pause windows — but **every write pops an operator confirmation the model can't answer**, and is refused when no operator is present. The bundled `operate-pi-dispatch` **skill** teaches the agent to use those gates.
- **Logs stay put.** Raw container output renders only in the overlay viewer, never into model context.

## Install the console

```bash
pi install npm:@edgehero/pi-dispatch-admin
```

Then run pi and open `/dispatch`. Point it at your deployment with `VALKEY_URL` / `PI_LOGS_DIR` / `PI_SETTINGS_FILE` / `PI_TRIGGERS_FILE` / `PI_PAUSE_WINDOWS_FILE` / `PI_SUBSCRIPTIONS_FILE` / `PI_GLOBAL_PI_DIR` — the same values your worker uses. It reads that deployment's queue and run history; on its own it will just say "queue unreachable."

## Get the whole thing

The queue, worker, container image, and GitHub webhook receiver — the actual service — are in the main repo. **Start there:**

### → **https://github.com/edgehero/pi-dispatch**

MIT, self-hosted. Read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md) before you rely on it — it states plainly what is and isn't defended (short version: the trust model is a GitHub Action's — whoever can merge to your default branch can instruct the agent).
