First run in the browser. After one command, every remaining setup step runs from this page, each with a preview and Confirm, so nobody has to go back to the terminal. The terminal way stays one click away on every step.

**How a person uses it.**
- **The one command.** The only step in a terminal: `npx @edgehero/pi-dispatch up --console`. It starts the queue, runs the console as a service, makes the operator token and prints a one-time link that signs the person in here. From pi, `/dispatch setup` does the same and opens the page.
- **Progress.** A big "3 of 8 ready", with what is starting, and a segmented bar, one segment per step in its state's tone. The page is live, so steps turn Ready by themselves.
- **Ready** (side). Done steps fold to one line each: deployment, queue, operator token. *Add a viewer* takes a name and gives a link that works once, for 60 seconds.
- **Start the worker.** One button. The step shows its progress as it happens: the service unit written, started, then waiting for the first heartbeat. Each start names the service manager, the host and the account it runs as, and has its audit row and a *Stop it* link.
- **Start the egress proxy.** One button, plus *Review the allowlist* (12 hosts), because the allowlist is what the proxy enforces.
- **Provider key.** Two choices:
  - use the pi login doctor found on the host, which stores nothing;
  - paste a key into a write-only field. It is written once to `.env` and never shown again. The audit row keeps the key's name, never its value.
- **Add a first trigger.** Three recipes (fix on a label, a nightly tidy, answer a comment), each opening the trigger editor prefilled, with the triggers.json diff before anything is saved, or *Start from scratch*.
- **Connect GitHub (optional).**
  - Create a GitHub App: GitHub's own app-manifest flow opens, the person approves, and it returns here with the app's key.
  - Use the `gh` login on the host.
  - Paste a token, written once.
- **In a terminal instead.** Each step folds out the exact command.

**Panels.** `p-setup`, `p-setup-ready`, `p-setup-start`.

**The server provides.**
- The deployment pointer (last folder), Valkey reachability, and the signed-in token's name and role.
- Host registry rows and the service manager's state for each pi-dispatch service.
- The newest doctor result (egress proxy, provider key present or not and whether a pi login exists, forge credentials), the trigger count, and the progress of a running setup action.

**Who sees what.** A viewer sees the steps and their states, with no buttons, no key field and no forge choices. A read-only console shows the steps with the terminal commands only.

**What this asks the repo for.** None of these actions exist in the console today, so each is new:
- `up --console`: one command that also makes the operator token, installs the console service and prints a one-time link;
- a narrow supervisor that may only start, stop or restart pi-dispatch's own services through the user's service manager;
- doctor runs from the console;
- write-only `.env` fields for a closed list of key names;
- viewer tokens from the console (operator tokens stay CLI-only);
- GitHub's app-manifest flow, returning to the console on 127.0.0.1.

Each must keep the console's rules: operators only, preview then Confirm, an audit row, nothing on a read-only console. The wizard's rule that it never asks for the provider key becomes a choice: the pi login stays the first option.

**Why it works this way.**
- Every step runs from this page, and each one shows what it will do, then waits for the person's Confirm. Nothing starts a job until a trigger matches, so starting the worker is safe on its own.
- The page may run a closed list and nothing else, with no free commands and no other programs:
  - start, stop or restart pi-dispatch's own services (the worker, the receiver and the egress proxy);
  - run doctor and show its result;
  - write a provider key or a forge token to `.env`, once, from a closed list of names;
  - add a viewer. Operator tokens are still made in a terminal.

  Every action is a preview, then Confirm, and an audit row. Operators only; a read-only console offers none of it.
- A pasted key goes from the page to the file and nowhere else. The audit row keeps its name, never the value, and viewers never see the key step's form.
- Only label, comment, issue and pull request triggers need GitHub; schedules on local folders run without it, so the step is optional.
- Once set up, the Overview starts empty: nothing needs you, nothing runs, and build3 shows up under Hosts as soon as it beats.

**Fixture note.** All of it is sample: a deployment on build3 with no worker, no egress proxy and no triggers, while the worker is starting. The commands are the repo's, except `up --console`, which is proposed.
