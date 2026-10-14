# The operator console

A web page for managing the deployment, served by a process of its own, `pi-dispatch-console`. It sits beside the
`/dispatch` panel in pi, not in place of it: both read the same files and the same Valkey, and both write through the
same validated functions, so neither can do anything the other would refuse.

**What is in this release is the skeleton.** It has sign-in and sign-out, a page that says who you are signed in as,
`/api/whoami`, and one write, the [pause windows](pause-windows.md), with a preview and a confirm. The screens (runs,
parked runs, spend, queues, hosts) arrive with issue #641 and the other writes with #642. What this release pins is
the security model every one of them has to meet, so this page is mostly about access.

## Install

The console ships in the admin package, the same one that gives pi the `/dispatch` panel:

```bash
npm i -g @edgehero/pi-dispatch-admin
```

Run every `pi-dispatch-console` command as the account that runs the deployment, on the deployment's host. It finds
the deployment the way the panel does: `--deployment <dir>` if you pass it, else the folder the deployment pointer
names (written by `/dispatch setup`), else the current folder. It reads its settings from that deployment's `.env`;
a value exported in your shell wins, as it does for the panel.

## Create the first token

Nobody can sign in until there is a token, and `serve` refuses to start without at least one operator:

```bash
pi-dispatch-console token add --name rob --role operator
```

It prints the token **once**, on one line, starting with `pdc_`. Put it in your password manager now: the file keeps
only its sha256 hash, so it cannot be shown again. If you lose it, rotate it.

Give each person their own token, named after them. The audit log names the token behind every action, so a shared
token turns "who changed this" into "someone did". A second role, `viewer`, can sign in and read but every write
answers 403:

```bash
pi-dispatch-console token add --name sam --role viewer
```

The tokens live in `console-tokens.json` in the deployment folder (`PI_CONSOLE_TOKENS_FILE` moves it). It must be a
regular file at mode 0600, owned by the account that runs the console: `serve` refuses a symlink, a file anyone else
can read, or one another account owns, and says which. `token add` creates it that way.

## Start it

```bash
pi-dispatch-console serve
```

`serve` runs in the foreground and listens on `127.0.0.1:4790`. Open `http://127.0.0.1:4790/` and paste your token.
Only one `serve` runs per deployment: a second one refuses, naming the first one's lock, because two of them would
fork the audit log's chain.

To listen somewhere else, set `PI_CONSOLE_LISTEN`:

| Value | What it does |
|---|---|
| `127.0.0.1:4790` | The default. Loopback only. |
| `[::1]:4790` | IPv6 loopback. |
| `unix:/home/pi/.pi-dispatch/console/console.sock` | A unix socket at mode 0600. The folder must exist, belong to you and be closed to everyone else (`chmod 700`). The path must fit the platform's limit: at most 103 bytes on macOS, 107 on Linux. |
| any other IP literal | Refused, unless `PI_CONSOLE_BIND_PUBLIC=1`. Doctor then warns. |

Hostnames are refused: a name can resolve somewhere you did not mean. The console never terminates TLS. That is the
tunnel's job, below.

**Prefer the unix socket on a shared machine.** A loopback port is open to every account on the host, and, on Docker
Desktop, a job container can reach it through `host.docker.internal`. The console refuses a request whose Host is
that name, which stops a browser or a client that keeps the name it dialled, but a program in the job can send any
Host it likes, so against a job the token is what holds. A socket only you can open removes the path entirely; on
Docker Desktop, use it. It also stops another
account from spending the login rate limit and slowing your own sign-in.

## From another machine

Forward a local port over SSH and open it in your browser. To a console on the default TCP port:

```bash
ssh -L 4790:127.0.0.1:4790 host
```

To a console on a unix socket:

```bash
ssh -L 4790:/home/pi/.pi-dispatch/console/console.sock host
```

Then open `http://localhost:4790/` on your own machine. The local port can be anything: the console checks the
hostname your browser sends (`127.0.0.1`, `localhost` or `[::1]`), not the port, so `ssh -L 8080:...` works too.
Any other hostname is refused with 421, which is what defeats DNS rebinding. If you reach the console through a name
of your own, list it in `PI_CONSOLE_ALLOWED_HOSTS`. The container gateway names (`host.docker.internal`,
`host.containers.internal`, `gateway.docker.internal`) can never be listed: the console refuses to start if you try.

Whoever can use the forwarded port on your machine can reach the console's sign-in page. They still need a token.

## Sign in without pasting the token

On the host, as the deployment's account:

```bash
pi-dispatch-console link --name rob
```

It prints a link like `http://127.0.0.1:4790/login/code#<code>`. Open it within 60 seconds (through a tunnel, keep
the path and the part after `#`, and use your tunnel's host and port). The code is not your token: it signs in `rob`
once and is then gone, and it sits after the `#`, which your browser never sends to a server, so it does not land in
a request log or a `Referer`. A small script on the page posts it. The codes are files in `console-login-codes/`
beside the tokens file, a folder only the deployment's account can open.

## Sessions

Signing in sets one cookie, `pdc_session` (`HttpOnly`, `SameSite=Strict`). A session ends:

- after `PI_CONSOLE_IDLE_MINUTES` without a request (default 60);
- `PI_CONSOLE_MAX_HOURS` after sign-in, however busy (default 12);
- when you sign out;
- when its token is revoked or rotated, or its role changes, on the next request;
- for everyone, when you run `pi-dispatch-console sessions end-all`;
- for everyone, when `serve` restarts, because sessions live in the process.

## Managing tokens

| Command | What it does |
|---|---|
| `token add --name <n> --role operator\|viewer` | Creates a token and prints it once. Refuses a name that exists. |
| `token list` | Names, roles and creation dates. Never a token or a hash. |
| `token rotate --name <n>` | A new secret for that name, printed once. Its sessions end. |
| `token revoke --name <n>` | Removes the name. Its sessions end. |
| `sessions end-all` | Ends every session; every token stays valid. |

Each of these except `token list` appends a row to the audit log, with the actor `shell`.

Your pi session's `write` and `edit` tools cannot touch the tokens file: the `/dispatch` extension guards it, so a
prompt injection in the operator's session cannot mint itself a login that way. Its `bash` tool can, which is the
same residual every guarded file has ([`SECURITY.md`](../SECURITY.md)).

## Writes

A write is two steps. The preview shows the change as a diff; the confirm applies it. The confirm carries only a
ticket the preview handed out, which works once, for your session, for 5 minutes, and only for that change: if the
file changed after the preview (the panel, another browser, a hand edit), the confirm is refused and nothing is
written. Preview again.

Writes are refused (403) when:

- the console is read-only (`PI_CONSOLE_READ_ONLY=1`), which turns every write off and leaves reads and sign-in on;
- the session is a viewer's;
- the request did not come from the console's own page (another site, or another app on another `localhost` port);
- the content type is not JSON.

Each such refusal is a line in the audit log. A refused request that carried no session is written one line each up
to 60 a minute; past that, refusals are counted and the count is written as one line, so whoever can reach the port
cannot grow the log without bound. A body too large (413) or not valid JSON (400), and a change the preview refuses
as invalid, are answered and not audited: nothing reached a write.

## The audit log

Every write, every write refused by a guard (as above), every sign-in, failed sign-in, used link and sign-out, every
token change and every `serve` start is a line in `PI_LOGS_DIR/console-audit/YYYY-MM.jsonl`. A line names the token's person and role, a
short digest of the session, the action, its target and its outcome, and for a write the digests of the file before
and after. It never holds a token, a code, a cookie or what was sent.

Each line carries the sha256 of the line before it, so an edit shows:

```bash
pi-dispatch-console audit verify
```

It names the first file and line where the chain breaks. The worker's retention sweep (`PI_LOG_RETENTION_DAYS`)
removes month files past the retention, never the newest one; when it has removed older months, it says where the chain now starts rather than calling that a break. The chain shows an edit;
it does not prevent one, since whoever can write the file can rewrite every line after the one they changed. The rows
`serve` writes are also copied to the Valkey list `console:audit` (the newest 500), best effort; the file is the
record.

## What doctor checks

`pi-dispatch doctor` checks the console only once you have set it up (a tokens file exists, or any `PI_CONSOLE_*` is
set). It then checks:

- the tokens file is a regular file, mode 0600, yours, and holds at least one operator;
- the tokens file is not inside any path a job container can see (a local trigger's `run.folder` or
  `run.skillsDir`, a `PI_DISPATCH_RUN_ROOTS` root, `PI_GLOBAL_PI_DIR`);
- `PI_CONSOLE_LISTEN` is a value `serve` would accept;
- `PI_CONSOLE_BIND_PUBLIC=1` (a warning, every time);
- the audit chain verifies (a warning when it does not).

## Reference

| Setting | Default | What it does |
|---|---|---|
| `PI_CONSOLE_LISTEN` | `127.0.0.1:4790` | Where `serve` listens: `127.0.0.1:<port>`, `[::1]:<port>` or `unix:/abs/path`. |
| `PI_CONSOLE_TOKENS_FILE` | `console-tokens.json` | The tokens file, relative to the deployment folder. |
| `PI_CONSOLE_ALLOWED_HOSTS` | none | Extra hostnames the console answers to, comma separated. |
| `PI_CONSOLE_READ_ONLY` | off | `1` refuses every write. |
| `PI_CONSOLE_BIND_PUBLIC` | off | `1` allows a non-loopback IP literal in `PI_CONSOLE_LISTEN`. |
| `PI_CONSOLE_IDLE_MINUTES` | 60 | Idle limit of a session, 5 to 1440. |
| `PI_CONSOLE_MAX_HOURS` | 12 | Absolute limit of a session, 1 to 168. |
| `PI_CONSOLE_MAX_STREAMS` | 4 | Live streams one session may hold, 1 to 32 (used by the screens from #641). |

The console also reads `PI_LOGS_DIR` (the audit log), `VALKEY_URL` (the mirror) and `PI_PAUSE_WINDOWS_FILE` (the one write), from the same deployment.

The design and its rejected alternatives are `DES-OPERATOR-CONSOLE` in [`specs/design.md`](../specs/design.md); the
testable rules are `REQ-CONSOLE-SECURITY` in [`specs/requirements.md`](../specs/requirements.md); the threat model and
what it does not defend are in [`SECURITY.md`](../SECURITY.md#the-operator-console).
