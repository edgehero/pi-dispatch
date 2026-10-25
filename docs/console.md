# The operator console

A web page for managing the deployment, served by a process of its own, `pi-dispatch-console`. It sits beside the
`/dispatch` panel in pi, not in place of it: both read the same files and the same Valkey, and both write through the
same validated functions, so neither can do anything the other would refuse.

It shows the whole deployment, live: what is running and queued on every host, every run with filters, the runs
waiting for an answer, spend and insights for a range of days, the schedules, the configuration and the console's own
audit log. Open pages update themselves about once a second while you watch, and `/api/state` gives a script the same
snapshot as JSON. It can also change all of it: cancel, retry, remove and re-run jobs, answer a parked run, pause
the fleet or one queue, and edit the configuration, each with a preview and a confirm ([Actions](#actions)). An
operator can watch a running job's transcript live on its run page, whichever host runs it
([The live transcript](#the-live-transcript)).

The first half of this page is about access, because the console is the most powerful surface after a shell on the
host. [The screens](#the-screens) starts below that.

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

As it starts, it prints where it listens, the tunnel for another machine, and how to sign in. It never prints a
token, only the commands that make one or a one-time link:

```text
pi-dispatch console on http://127.0.0.1:4790/
from another machine: ssh -L 4790:127.0.0.1:4790 <this host>, then open http://localhost:4790/
sign in: paste a token (pi-dispatch-console token add --name <you> --role operator makes one), or open a one-time link: pi-dispatch-console link --name <you>
```

On a unix socket the last line ends with `--port <your tunnel's local port>`: a link through a tunnel needs the port
you forward, which only you know ([From another machine](#from-another-machine)). The sign-in page gives the same
help, with the commands in boxes to copy.

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

## Keep it running as a service

`serve` stops with its terminal. To keep the console running, install it as a service from the deployment folder:

```bash
pi-dispatch service install --console
```

That is a LaunchAgent on macOS, a `systemctl --user` unit on Linux (`--system` prints the sudo commands instead) and
an nssm service on Windows, like the worker's ([`README.md`](../README.md#run-as-a-service)). The unit runs
`pi-dispatch-console serve --deployment <this folder>`, so it reads this folder's `.env` and tokens file.
`service status --console`, `start`, `stop`, `restart` and `uninstall` take the same flag.

`install` refuses in two cases, before it writes anything:

- the console is not installed where it can find it. Install the admin package where the worker is installed:
  `npm install -g @edgehero/pi-dispatch-admin` beside a global worker, or `npm install @edgehero/pi-dispatch-admin` in
  the folder whose `node_modules` holds the worker. A `pi-dispatch-console` on your PATH is used only when it is that
  package's own file (a pnpm or Volta shim is not), and on Windows the PATH is not searched;
- the tokens file holds no operator token: `serve` would refuse to start, so the service would never run. Add one
  with `pi-dispatch-console token add --name <you> --role operator` first.

When `serve` refuses (exit 2: no operator token, another console holding the lock, an unusable address), the service
stays stopped instead of restarting. Fix the cause, then `pi-dispatch service start --console`.

After a crash the lock (`console-audit/.console.lock` in your logs folder) still names the dead console's pid, and the
next start takes it over. If another process has taken that pid since, every start refuses and names it: when that
pid is not a console, remove the lock file and start the service again.

The service does not load your `.env` into its environment: `serve --deployment` reads the file itself and takes only
the console's own settings from it, so the worker's secrets never reach the console process.

`pi-dispatch doctor` says whether a console service is installed for the deployment and whether the console answers
on its address (one `GET /healthz` to the loopback address or the socket, never anywhere else). An installed service
that does not answer is a failure; no service and nothing running is a warning. `pi-dispatch up` names the install
command once an operator token exists.

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
Any other hostname is refused with 421, which is what defeats DNS rebinding. Three files answer on any name: the
console's script, its stylesheet and its empty favicon, which hold nothing a session or a rebound name could use, and
which the 421 page itself loads to draw. If you reach the console through a name of your own, list it in
`PI_CONSOLE_ALLOWED_HOSTS`. The container gateway names (`host.docker.internal`,
`host.containers.internal`, `gateway.docker.internal`) can never be listed: the console refuses to start if you try.

Whoever can use the forwarded port on your machine can reach the console's sign-in page. They still need a token.

To sign in through the tunnel without pasting the token, make the link for your tunnel's local port:

```bash
pi-dispatch-console link --name rob --port 4790
```

It prints `http://localhost:4790/login/code#<code>`, ready to open on your own machine. The console cannot know that
port (a unix socket has none, and a tunnel can forward any free one), so you name it: `--port` takes a number from 1
to 65535, a bad one is refused before any link is made, and it is refused on every command but `link`. Without
`--port`, a console on a unix socket prints its link with `<the local port of your ssh -L tunnel>` where the port
goes.

A page opened by a name the console does not answer to (a hostname of your own that is not in
`PI_CONSOLE_ALLOWED_HOSTS`, say) says so and gives the `ssh -L` command for the address and port you came in on
([Error pages](#error-pages)).

## Sign in without pasting the token

On the host, as the deployment's account:

```bash
pi-dispatch-console link --name rob
```

It prints a link like `http://127.0.0.1:4790/login/code#<code>`. Open it within 60 seconds (through a tunnel, add
`--port <your tunnel's local port>` and the link is printed for it, [above](#from-another-machine)). The code is not
your token: it signs in `rob` once and is then gone, and it sits after the `#`, which your browser never sends to a
server, so it does not land in a request log or a `Referer`. A small script on the page posts it. The codes are files
in `console-login-codes/` beside the tokens file, a folder only the deployment's account can open. If that folder is
ever open to other accounts, the console refuses it: remove the folder (what it holds cannot be trusted) and make a
new link, which creates it again.

The link's page says "Signing in with a one-time link" while it works. A link that was used, has expired or is
unknown says so and gives both commands for a new one (`pi-dispatch-console link --name <you>` on the host, and
`/dispatch console --link` in pi); a link that lost the part after `#` says it carries no code. Each state offers the
token form instead. If the console does not answer, the page stays, says "Console not reachable, retrying" and posts
the same code again every 2 seconds, for at most 30 tries or 60 seconds, whichever comes first. Then it stops, says the
link has expired (a link lasts 60 seconds), and asks you for a new one once the console is back. Too many sign-in
attempts at once (the console's sign-in limit) do not use the link up: the console turns the post away before it
reads the code, so the page keeps saying it is signing in, tells you to wait a minute, and the same link still works
within its 60 seconds; open it again. A new link pasted into a tab that shows this page loads the page again for it.

The sign-in page itself says why a sign-in was refused, one notice at a time above the field: a token that is not
valid for this console, too many attempts (wait a minute), a tokens file the console cannot use right now (an
operator should run `pi-dispatch doctor` on the host), or an audit log it could not write, which refuses the sign-in.
(A used or expired link is said on the link's own page, above.) A sign-in that reaches nothing keeps the page and is
sent again every 2 seconds until the console answers, for at most 30 tries or 60 seconds: then nothing more is sent,
the page no longer holds the token, and it asks you to paste it and press Sign in again once the console is back.
The field is cleared as soon as you press Sign in. Under it, "No token yet?" gives the pi command
for a link (`/dispatch console --link`) and the host command for a token, each in a box to copy, and a line says where
the console answers: on this host's loopback address only, on its unix socket only, or nothing about it on a public
bind. Signing in needs JavaScript. A page without it says so first, and shows only what still holds: the token form,
its lead-in and the link page's "Signing in" state are drawn hidden, and the page's script shows them as it loads.

### From pi: `/dispatch console`

In pi, `/dispatch console` does the same in one step, without a second terminal:

```text
/dispatch console [runs|fleet|insights|config|parked|audit|<run id>] [--link [token name]] [--no-open]
```

- **The address.** It prints the page's URL by the same rules as `/dispatch insights`: the loopback URL, the `ssh -L`
  line for a unix socket, `<this host>` for a bind on every address, and a sentence for port 0 or a value that does
  not parse. A run id opens `/run?id=<id>`; no page opens the overview.
- **Running or not.** It asks the console once, `GET /healthz` with a one second limit, at this host's loopback
  address or the socket and nowhere else (the same check doctor makes), and says `running`, `not running` (with why,
  and how to start it or keep it running as a service), or that it cannot tell and why (port 0, a non loopback
  address).
- **`--link`** makes a one-time sign-in link, like `pi-dispatch-console link`, for an operator token: the one there
  is, the one you name (`--link rob`; the page goes before `--link`), or the one you pick when there are several. It
  is shown only to you, in pi's notice: never in the conversation, never a tool. Its row is written to the audit log
  (actor role `panel`) before the code is made, so no code exists that the log does not hold. None is made unless the
  console answers as running, and none in pi's RPC mode (where the notice goes to another program) or where the panel
  cannot see the deployment's tokens file (start pi in the deployment folder, or run `/dispatch setup`). The link
  names the page too, after the code: `.../login/code#<code>&next=/runs`, and after signing in you land there. The
  console only ever lands you on one of its own pages; anything else lands on the overview.
- **The browser** opens by itself on a local session: not over SSH (`SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY`),
  and on Linux only with a display (`DISPLAY` or `WAYLAND_DISPLAY`), for a TCP address (a socket needs your tunnel
  first). `--no-open` keeps it closed. The URL is printed every time. A sign-in link is handed to the browser through
  a small private page in a temporary folder, so the code never sits on the opener's command line, where other
  accounts on the host could read it. It still shows in pi's notice and, until it is used, in the browser's history.
  The page is opened by your desktop's handler for `.html` files, usually the browser. A snap or Flatpak browser on
  Linux has a private `/tmp` and shows the page as not found; the notice says so, so open the printed link instead.

One-time links do not work on a Windows host: Windows reports every folder as open to other accounts, so the console
refuses the `console-login-codes/` folder there. Paste the token instead.

It never starts the console: run `pi-dispatch-console serve` for that, or keep it running with `pi-dispatch service
install --console` ([above](#keep-it-running-as-a-service)).

## Sessions

Signing in sets one cookie, `pdc_session` (`HttpOnly`, `SameSite=Strict`). The theme button sets a second one,
`pd_theme`, which holds only your theme choice and is no part of a session ([Look and theme](#look-and-theme)). A
session ends:

- after `PI_CONSOLE_IDLE_MINUTES` without a request (default 60);
- `PI_CONSOLE_MAX_HOURS` after sign-in, however busy (default 12);
- when you sign out;
- when its token is revoked or rotated, or its role changes, on the next request;
- for everyone, when you run `pi-dispatch-console sessions end-all`;
- for everyone, when `serve` restarts, because sessions live in the process.

Signing in again in the same browser ends the session it held before. Its other open live tabs wait a moment, ask
the console who this browser is now, and reload on the new session only if it is the same person (the same name and
role); otherwise they go to the sign-in page, which says this browser is now signed in as someone else, so a
one-time link someone else sent you, opened in another tab, never puts their console into a tab you were using.

**A page acts only as the person it was drawn for.** Every page says who it was drawn for when it opens its live
updates and when it previews or confirms a change, and the console refuses the request when this browser is now
signed in as someone else. An open page then cannot change anything as the other person, even a page that is not
live: its preview or confirm is refused with "this browser is now signed in as someone else, so nothing was
changed; sign in again", with Look again, which goes to the sign-in page saying this browser is now signed in as
someone else (it never reloads the page into the other person's console), and its live updates stop and send it to
the same sign-in page. The terminal chat and scripts do not
say a person and are not checked.

**Sign out** goes to the sign-in page only once the console confirms it. If the console does not answer within 10
seconds, or answers anything else, the page stays and says "Sign-out not confirmed" (once, however often you press
it): this browser may still be signed in, so press Sign out again. An answer that comes later still takes you to
the sign-in page. A sign-out ends every session the browser presents, so a second cookie another program on this
machine planted beside yours cannot turn it into a sign-out that ends nothing. Signing out needs no tokens file, so
it works while the console cannot read one (below).

**The sign-in page says why.** The next page you open after your session ended goes to the sign-in page, which says
in one line what happened:

| `ended` | What ended it | The sign-in page says |
|---|---|---|
| `idle` | no request for `PI_CONSOLE_IDLE_MINUTES` | You were signed out after 60 minutes without a request (your console's own limit; an open live tab does not count) |
| `max` | `PI_CONSOLE_MAX_HOURS` since sign-in | You were signed out after 12 hours (the longest a session lasts) |
| `revoked` | the token was revoked or rotated | Your token was revoked or rotated |
| `role` | the token's role changed | Your role changed, so you were signed out |
| `all` | `sessions end-all` | An operator ended every session (your token still works) |
| `elsewhere` | you signed out in another tab | This browser signed out in another tab |
| `restart` | the console restarted, perhaps | This console no longer knows this sign-in; it may have restarted |
| `switched` | nothing ended: another tab signed this browser in as someone else, and this page stopped rather than act for them | This browser is now signed in as someone else |

The console remembers why each session ended for that session alone, under its own random id, so the line says nothing
about any other token or session. It remembers the last 1024. The `restart` line is a guess, and says so: sessions live
in memory, so after a restart the console cannot tell your old cookie from one it never issued. It says it only while
the console has been running for less than `PI_CONSOLE_MAX_HOURS` (after that, a session from before would have ended
anyway) and has not yet forgotten an ended session; otherwise the sign-in page says nothing. The page takes the reason
only from its own list: a link to `/login?ended=` with anything else shows no notice, and nothing from the address is
ever repeated on the page. A script gets the same reason as `ended` in a 401's JSON
([The state API](#the-state-api)).

**A tokens file the console cannot read signs nobody out.** If the file stops being readable while the console runs
(a wrong mode or owner after an edit, say), every page or API request from a signed-in browser is answered "The
console's tokens file cannot be used right now" (503, with `pi-dispatch doctor` to run on the host), your browser
keeps its session, and open live pages stay connected and show their data as last seen, under a note that says the
console could not read its tokens file. Signing out still works. Once the file reads again everything carries on,
and a session that ended in the meantime (its idle limit, say) ends then, with its reason.

## Managing tokens

| Command | What it does |
|---|---|
| `token add --name <n> --role operator\|viewer` | Creates a token and prints it once. Refuses a name that exists. |
| `token list` | Names, roles and creation dates. Never a token or a hash. |
| `token rotate --name <n>` | A new secret for that name, printed once. Its sessions end. |
| `token revoke --name <n>` | Removes the name. Its sessions end. |
| `sessions end-all` | Ends every session; every token stays valid. |

Each of these except `token list` appends a row to the audit log, with the actor `shell`.

Your pi session's `write` and `edit` tools cannot touch the tokens file or anything in `console-login-codes/`: the
`/dispatch` extension guards both (a code file planted there would be a sign-in), so a prompt injection in the
operator's session cannot mint itself a login that way. Its `bash` tool can, which is the
same residual every guarded file has ([`SECURITY.md`](../SECURITY.md)).

## Writes

A write is two steps. The preview shows the change as a diff; the confirm applies it. The confirm carries only a
ticket the preview handed out, which works once, for your session, for 5 minutes, and only for that change: if the
file changed after the preview (the panel, another browser, a hand edit), or a job is no longer as the preview showed
it, the confirm is refused and nothing is written. Preview again. [Actions](#actions) lists every write.

**The preview bar.** A preview opens in one bar right after the card whose button you pressed, never inside a table.
While the console answers it says "Previewing" with Confirm greyed. Then it lists what will happen (a setting's
change reads "maxTurns: **30** to **40**"), the diff for a file, what a paid action will reserve, and a line saying how
the change can be undone. Where a write puts it back it reads **Undo:** and that write (deleting the trigger you add,
setting a setting back to the value it had, resuming the queue you pause, withdrawing the message you send). Where
there is none it reads "No undo:" and what you can do instead: for a deleted line, copy it from this preview, since
the console keeps no copy (for a deleted trigger that names secrets, its secret references come from your own copy
of the file, since the preview does not show them); for a retry or a re-run, the console cannot remove a waiting job,
but Cancel stops it once it runs; for a setting whose old value the form cannot send back (an empty one, say), set it
back by hand. The Confirm button says what it does ("Pause the fleet", "Delete trigger at index 1", "Retry for up to
$2.00", "Retry (zero-rated)" for a job that cannot spend), yellow for an action that spends and red for one the
console counts as destructive: a pause of the fleet or a queue (which Resume undoes, but which stops work), a cancel,
a removal and a delete. The bar counts down the preview's 5 minutes, and at 0:00 Confirm stops working: preview
again.

The bar's other states:

- **No change**, with Close, when the change would write what is already there ("The file already says this:
  maxTurns is 40.").
- **Refused at the preview**, with Close: the console's reason, and that nothing was changed. Fix the form and try
  again.
- **Refused at the confirm**: Preview again (the confirmation expired, was used, or belongs to another sign-in), Look
  again (the file or the job changed since the preview; it reloads the page), Try again (Valkey could not be
  reached), or Close (the audit log could not be written, so nothing was; or the write failed, and the console's log
  has the reason). Each of these came before anything was written, and says that nothing was changed.
- **Refused for another person**, at the preview or the confirm, with Look again: this browser is now signed in as
  someone else (in another tab), so the page you are on may not act for them ([Sessions](#sessions)). Nothing was
  changed. Look again goes to the sign-in page, which says so.
- **The tokens file cannot be used**, with Look again: the console cannot read its tokens file right now, so it
  changed nothing; an operator should run `pi-dispatch doctor` on the host ([Sessions](#sessions)).
- A preview or a confirm whose session has ended (it was idle too long, say) shows no refusal: the page goes to the
  sign-in page, which says why, as a live page does when its updates stop.
- **Did not finish**, with Look again: the change stopped after doing part of its work. The kill switch can reach
  some queues and not others (a Valkey that did not answer, a loop that stopped part-way) or fail before it says which,
  and a bulk action can fail part-way through its jobs. The bar never says nothing was changed here: it says some of
  it may have been done, and Look again reloads the page so you see what did. The audit log has no outcome for a
  change that partly landed, so such a write's line reads `failed` (for the kill switch, its reason says what it
  reached).
- **No answer at all**: the bar says the change may or may not have been made. Reload to see; the audit log says
  which. The same confirmation is never sent twice.

**After a write** the page reloads and a banner at its top says what happened ("Paused the fleet", "Changed
maxTurns from 30 to 40"), who did it and its audit row, linked to that row on the audit page ("3 audit rows, from row
41" for a bulk action, linked to the first), with the Undo line again. Where the change has a way back, the banner's
**Undo** button opens that write's own preview with the old values filled in, so nothing is undone without you
seeing it first; where it has none, the line says what to do by hand (after a delete, that the console kept no copy
of the removed lines). The banner shows once. A bulk action with a job that did not go through shows each job's
result in the bar instead, with its audit rows and Reload; its banner on the next page is amber and says how many
were done ("2 of 3 done"), and a bulk action where no job went through leaves no banner at all.

**A field an action does not take is refused.** Every action takes only the fields its form sends; any other is
refused by name with the fields it does take, and nothing is changed. A field whose name is not a plain word is
called "a field it was sent", and a value you sent is never repeated. The AI tool that adds a trigger refuses a field
its trigger type does not take the same way, before you are asked to confirm ([`triggers.md`](triggers.md)); the
console's own trigger form says "this form does not take ..." in the same words.

**Row numbers.** The pages drawn in the new design count their rows from 1 (the audit page's "row 41" is the 41st
row the log ever held). The Configuration page still draws its tables and forms by the 0-based index its files use (the
Triggers table's "#" column, the "Row #" fields, "History row # (newest is 0)"), so until its row buttons arrive
everything the console says about one of its rows uses that same index, worded "index N": "Delete trigger at index
1", "pause window at index 0", the opted-out triggers of a secret bundle. In pi, the `/dispatch` panel and the tools
count from 1 ("Delete trigger #2" for index 1).

Writes are refused (403) when:

- the console is read-only (`PI_CONSOLE_READ_ONLY=1`), which turns every write off and leaves reads and sign-in on;
- the session is a viewer's;
- the request did not come from the console's own page (another site, or another app on another `localhost` port);
- the content type is not JSON.

Each such refusal is a line in the audit log, and so is a preview or confirm refused for another person. A refused
request that carried no session, and a sign-out that found no session to end, is written one line each up to 60 a
minute; past that, such lines are counted and the count is written as one line ("3 more rows without a session
(refusals and sign-outs) went unwritten one by one"), so whoever can reach the port cannot grow the log without
bound. A signed-in write whose body is too large (413) or not valid JSON (400) is a line
too, with a fixed reason and nothing of the body; a change the preview refuses as invalid is answered and not
audited, since nothing reached a write.

## The audit log

Every write, every write refused by a guard (as above), every sign-in, failed sign-in, used link and sign-out, every
token change and every `serve` start is a line in `PI_LOGS_DIR/console-audit/YYYY-MM.jsonl`. A line names the token's person and role, a
short digest of the session, the action, which write it was (`kind`, such as `failed-retry` or `trigger-edit`), its
target and its outcome, and for a write the digests of the file before and after. A paid action's line also holds
the reserve it showed (`reserve`, in micro-dollars), and a bulk action writes one line per job, each with the size of
the batch (`count`). It never holds a token, a code, a cookie or what was sent: an answer to a parked run is recorded
by its sha256, never its text.

**Writes from pi are in the same log.** What you change from the `/dispatch` panel, its commands and dialogs, or what
the pi extension's tools change after your confirm, is written to this log too, with the role `panel` and your
account's login name, so one log says what changed whichever surface changed it. The line is written before the
change, and if it cannot be written (a full disk, a logs folder you cannot write) the change is refused with a
sentence saying so. Fix the folder and try again. The one exception is `/dispatch setup`, which builds the deployment
before there is a log to write to.

Each line carries the sha256 of the line before it, so an edit shows:

```bash
pi-dispatch-console audit verify
```

It names the first file and line where the chain breaks. A row is vouched for only by the next line's link to it (its
`prev`, the row's sha256), so when that line does not carry a link that matches (it is not a row at all, its link is
missing or malformed, or it is another row's), whatever else is wrong with it, it says the row before it is not
vouched for either ("Row 7 before it (2026-10.jsonl line 7) is not vouched for either: the link between the two does
not hold, so the chain cannot tell whether row 7 was changed.") and that the rows through the one before that are
intact. When the line's link matched and it fails another check,
the row before it is intact. The worker's retention sweep (`PI_LOG_RETENTION_DAYS`)
removes month files past the retention, never the newest one; when it has removed older months, it says where the chain now starts rather than calling that a break. The chain shows an edit;
it does not prevent one, since whoever can write the file can rewrite every line after the one they changed. The rows
`serve` writes are also copied to the Valkey list `console:audit` (the newest 500), best effort; the file is the
record.

**The audit page** (`/audit`, operators only, under More) shows the log newest first, 50 rows a page, with Newest and
Older to move through it. Above the rows a banner says how far the chain is verified: "Chain verified through row
1204", or, when an older month was reaped by the retention sweep, from which row (a reaped start and a removed one
look alike, and the banner says so). When a row is damaged it says "Chain verified through row 6. Line 8 of
2026-10.jsonl is damaged.", the check's reason, and what to do: keep the file as it is and compare it with your last
backup; `pi-dispatch-console audit verify` names the same line. The damaged place is always named by its line in its
file, as `audit verify` names it, never by the row number it carries: that number is part of what may have been
changed. Its "Show the damaged line" button opens the page at that line. When line 8 does not carry a link that
matches row 7 (it is not a row, its link is missing or malformed, or it is another row's, whatever else is wrong
with it), the banner also says that row 7 cannot be trusted either: an edit to row 7 leaves its own line well formed
and shows only in row 8's link, so nothing says whether row 7 was changed, and the verified range ends at row 6.
Only a line whose link matched and that is damaged in another way (a seq out of order, an action, outcome or field the
console never writes) leaves the row before it verified. The newest row has no line after it, so nothing vouches for
it, and the next row the console writes links to it as it then is on disk: an edit made to the newest row before
another row is written is never seen ([`SECURITY.md`](../SECURITY.md)).

Each row shows who (name and role), the action and which write, the target, the outcome as a badge with a mark and a
word, and the reason, with a bulk action's line saying it is one of how many in a bulk write and a resume's how many
jobs were waiting to start. A row's outcome is shown only where the chain vouches for it. The damaged row is tinted,
with the check's sentence beside it; every row after it reads **not verified** (it may say anything about itself; the
outcome it was written with is in a note), and so does the row before it when the damaged line carries no link that
matches it, with a note saying the link to the row after it does not hold; a row written after the last check reads **unchecked** until
the next one;
and a line that is not a row at all is shown as damaged in its place, never skipped. The check re-reads the whole log,
so the page reuses it for 30 seconds, and **About this log** says when it last ran, the verified range, the damaged
line and what is not verified.

The filters are a search over targets and reasons (at most 64 characters) and three lists: who, the action and the
outcome; the search matches in any case. A filtered view is a plain link. It searches 500 rows at a time and stops
after 2,000, saying once how many rows matched among how many it searched ("20 rows match among the 2,000 rows
searched", "from here" on an Older page); its Older link searches on from there, so a search never claims "no match"
for rows it did not read. A damaged line or row is shown under every filter, in its place, and is not counted as a
match: the chain does not vouch for what it says, and a filtered view that hid it would look clean. A filter value
outside its list or its characters is refused by the parameter's name, never repeated back.

`/audit?seq=<n>` opens the page that holds row n, at the row (`/audit?seq=41#seq-41`), however many rows were written
since: the banner after a write links its row this way. The page finds the row by its number, from where the last check
counted each month file to start, and reads it there in one go. A page whose rows run past what the last check counted
(rows written since, or after a damaged one) starts at the last row the check counted, and the newer rows are on the
pages above it. Where the check did not count the row itself (a row newer than the check, a row past a damaged one, or
no check at all) or the files have changed since, the page searches for it from the newest row instead, up to 2,000
rows, and says how it found the row, or why it did not ("The page that holds row 125, found by reading from the newest
row: the last chain check counted rows up to row 120."). A row older than the log's first says it was reaped by
retention or removed, and a row past the newest says it does not exist yet. `seq` takes no filter: `?seq=` with `who`,
`action`, `outcome` or `q` is refused, since the page it opens is the row's own, unfiltered.

## What doctor checks

`pi-dispatch doctor` checks the console only once you have set it up (a tokens file exists, or any `PI_CONSOLE_*` is
set). It then checks:

- the tokens file is a regular file, mode 0600, yours, and holds at least one operator;
- the tokens file is not inside any path a job container can see (a local trigger's `run.folder` or
  `run.skillsDir`, a `PI_DISPATCH_RUN_ROOTS` root, `PI_GLOBAL_PI_DIR`);
- `PI_CONSOLE_LISTEN` is a value `serve` would accept;
- `PI_CONSOLE_BIND_PUBLIC=1` (a warning, every time);
- the audit chain verifies (a warning when it does not).
- whether a console service is installed for this folder (`pi-dispatch service install --console`) and whether the
  console answers on its address: a failure when the service is installed and nothing answers, a warning when there
  is no service and nothing runs.

## The screens

A viewer sees every page except the audit log, never the reason text of a failed job (below), and never a full local
folder path on the insights page (an operator can ask for those with `?paths=full`). The buttons and
forms that change something ([Actions](#actions)) are shown to operators only, and not at all on a read only
console.

Every page has the same bar along the top: the navigation (Overview, Runs, Parked, Fleet, Spend and Configuration),
the live pill on the pages that update themselves ([Live updates](#live-updates)), the theme button
([Look and theme](#look-and-theme)), a "Read-only console" chip when `PI_CONSOLE_READ_ONLY=1` is set, who is signed
in, and Sign out. Spend is the `/insights` page. Parked shows how many parked runs are waiting for an answer, kept
current on the pages that update themselves; it shows no number when none is waiting or the count could not be
read. An operator also gets **More**, which holds the audit log; a viewer has no More. The first thing the keyboard
reaches is a "Skip to content" link, which jumps past the bar. A read-only console also says so in a banner under
every screen's title ("This console is read-only"): every change is refused and no page shows a form.

The bar's layout depends only on the window's width and on whether the console is read-only, never on what the bar
shows, so it does not move, on a phone or a desktop, when the live pill's state changes, when the theme button
appears or when the Parked count changes. The theme button's place is kept for it while the page loads (and, without
JavaScript, stays an empty gap), so showing it moves nothing either.

- On a wide window (1440 pixels or more, 1600 on a read-only console) the bar is one row: pi-dispatch, the
  navigation, then the rest.
- On a narrower desktop window it is two rows: pi-dispatch with the rest of the bar, then the navigation across the
  whole width with every pill in view (below 940 pixels it breaks after Fleet onto a second line). Where the first row
  is short of room the signed-in name and role give way, cut with an ellipsis; the tooltip over who is signed in
  holds both whole ("ops, Operator").
- On a phone (760 pixels or less) the navigation is a row of its own that scrolls sideways. The page you are on is
  scrolled into view once when the page loads, and a pill the keyboard moves to is scrolled wholly into view, its
  focus ring included; the row never scrolls back by itself, so where you scrolled it stays.

More opens its list right under its own button. It closes on Escape, on a click outside it and when the keyboard's
focus leaves it. On a phone, opening it (a tap, a click or a screen reader's activation) first scrolls its button
wholly into view, and it closes when you then scroll the navigation (or turn the phone) so far that its button is
wholly out of view. On a phone the live pill is one small mark whose shape says the state, its word kept for screen
readers ([Live updates](#live-updates)).

| Page | What it shows |
|---|---|
| `/` | The overview ([The overview](#the-overview)): the running jobs and how many runs are waiting for an answer (and how many of those are being answered now) first, then whether the fleet is paused and whether any worker is online, the queue counts, today's spend against the caps, the hosts online and how long ago each last checked in, and the problems of the last 24 hours: failed runs, and refused runs with their most frequent reasons. |
| `/runs` | Every run this host and the fleet's run mirror know of, newest first, with filters and paging. The Outcome column says completed, refused, failed, awaiting input or cancelled, amber for refused, awaiting input and cancelled and red for failed. A refused or failed run also names its reason as a short sentence ([Outcomes and reasons](#outcomes-and-reasons)). |
| `/run?id=<job id>` | One run, led by its **Outcome**: the outcome word, what the reason means, what to do about it, and a link to the reason's entry in [reasons.md](reasons.md) on GitHub ([The run page's outcome](#the-run-pages-outcome)). Then the run's record: outcome, reason, tokens and dollars, resources, session, chain, and a link to the issue or pull request on its forge. In a project with a secret bundle, the variable names the run received and from which bundle, the names its trigger's `run.secrets` shadowed and, on an OpenShell venue, how many were placeholders; or why it ran without the bundle. It says whether the record came from this host or from the mirror. Its **Chat** panel, between Progress and Inbox, says what chat the run can have now ([The Chat panel](#the-chat-panel)). For a steer-armed job, its inbox ([Steering a running job](#steering-a-running-job)). For an operator, the run's live transcript below it ([The live transcript](#the-live-transcript)). |
| `/parked` | The runs waiting for an answer, with a link to where the question was asked, its age, how many times the session was resumed, and an **Answer** column: waiting, being answered by a run (linked), or unknown. |
| `/insights?range=30d` | Spend: the insights, the deployment's one analytics page ([`insights.md`](insights.md)), for `7d`, `30d` (the default) or `mtd` (month to date): the charts, the budget and its split, job sizes, capacity, plans, the breakdowns and the interactive trigger/flow topology, plus a what-if form (`&whatif=<provider>/<model>&flow=<flow>`) that every role may use, since it only reads. `/dispatch insights` in pi prints this page's URL. |
| `/fleet` | Job counts per queue and state, the jobs held on a wait (Held), each host with its slots, budget (CPUs in cores), running jobs and the venues it blesses (its default first), each host's last doctor run ([Doctor results](#doctor-results)), every running job, the venues, the schedules with their next and last run and whether one has stalled, and the failed jobs, each linked to its run page with its record's reason and what it means (the queue's own error text is in the operator's details below the list). |
| `/config` | The triggers, the settings overlay, the pause windows, the scoped limits, the projects, the envelope and allocation, the MCP servers, the staged packages, the secret profiles (their names only, never where a secret comes from or its value; those `PI_SECRET_PROFILES` declares are listed beside the overlay's, and a name in both is marked ambiguous; a "Secret profiles in use" table gives each profile's source, where its resolver stands against `PI_SECRET_RESOLVER_ROOTS`, the triggers and projects that use it, the last resolve a run recorded and the live hosts that advertise it, still with no path: [`secrets.md`](secrets.md#from-the-panel)), and the secret bundles: each project bundle in `triggers.json` with its project, its profile and whether this deployment declares it, fork reviews, its endpoint names and hosts, the triggers that opt out and the variable names the newest run received, plus the bundle resolvers by name and format ([`secrets.md`](secrets.md#from-the-panel)). Never a bundle's reference or a value. |
| `/audit` | The console's audit log, newest first. Operator only, under More in the navigation. How far its hash chain is verified, which rows it does not vouch for, filters and a search ([The audit log](#the-audit-log)). A line that is not a valid row is shown as damaged in its place, never skipped. |

### Look and theme

The console follows your system's light or dark setting. The theme button in the top bar cycles three choices:
follow the system (the default), light, and dark; its tooltip says which one is on. A choice of light or dark is kept
in your browser as the cookie `pd_theme`, which holds `light` or `dark` for a year, for every page of this console
(`Path=/`, `SameSite=Lax`); going back to the system's setting deletes it. The console reads it to draw each page,
the sign-in page included, in your theme from its first byte, so a page never shows the other theme first. It is `Lax`
so that this holds also when you arrive from another site, where the pages you can land on are the sign-in page and a
one-time sign-in link (`pi-dispatch-console link`) opened from a chat or a mail: `Strict` would withhold the cookie on
exactly that first request. Any other console page you reach from another site is first a redirect to the sign-in
page, because the session cookie is `Strict`. The console itself never sets it.

The cookie is a preference, not a credential: it signs nobody in and opens nothing. The console takes only an exact
`light` or `dark` from it, and anything else, or two copies of it (set for two paths), draws the system's theme. What
it holds is never copied into a page, a log line or the audit log.

It is not `HttpOnly`, because the console's own script writes it when you click the button, and a browser keeps
cookies per host name, not per port. So any page served from the console's host name (another service on `localhost`,
say) can read it, and your browser sends it to those services too: they learn your theme choice and nothing else.
Such a page can also overwrite it, or plant a second copy for a path of its own. A copy for a path is sent only
with the pages under that path, so those pages, and only those, carry two copies and are drawn in the system's theme,
and there the theme button changes only the page you are on, until the stray copy expires or you clear the site's
cookies. A copy planted with a `Domain` attribute depends on how you reach the console (measured in Chrome): on
`localhost` or an IP address it replaces yours, but on a console served under a domain name it is a second copy beside
yours on EVERY page, as is a copy that a site on a sibling host name set for the parent domain. Then every page is drawn
in the system's theme, and the theme button changes only the page you are on, until that copy expires or you clear
the site's cookies. All of this is cosmetic: none of it reaches a session, what a page shows or a write.

Without JavaScript the theme button is not shown (its place in the bar stays empty), and a page follows the system (or
a choice the cookie already holds).

A test holds every colour pair the design declares (56 in each theme: each text colour on the grounds it is used
on, each status's ink on its tint and its text on its solid colour, the focus ring on the canvas and every surface)
to WCAG AA contrast in both themes. A status mark's own colour is exempt (the amber attention mark is 2:1 against a
card in the light theme), because a mark is not what tells a state: every status badge is an icon and a word; the
kit's coloured dot is, by its rule, drawn only beside the word it marks (given a label, it also carries a name for a
screen reader), though no page draws one yet; and every state of the live pill is a word beside its mark, except on a
phone, where the pill is one mark whose shape says the state (a dot for Live, a retry arrow for Reconnecting, a stop
square for Not live, the sign-out arrow for Signed out), each at 3:1 or more against the bar in both themes, its word
kept for screen readers. Until a page is redrawn in the new design its panels are the old ones, and their colour
combinations are not measured.

Every page is checked in CI at a phone's width, 375 pixels, where it must not scroll sideways: wide tables, the
navigation and the charts scroll inside their own box. So are the sign-in pages, the 404, 400, 403, 421 and 503
error pages, and each of these states as the server draws it: the preview bar previewing, a plain, a paid and a
destructive preview, a preview with a line that has no space to break at, no change, a bulk preview and its results,
one refusal at the preview and one at the confirm, the refusal for another person, a change that did not finish,
and the banner after a write with an Undo and without one; each live note, a page shown as last seen and a panel
kept still; the read-only banner; the audit page's damaged and not verified rows; every notice of the sign-in page
and every state and notice of the one-time link's page. The top bar is checked too, at 320 and 375 pixels as a phone and
at 761, 800, 940, 1024, 1180, 1280, 1440 and 1600, for an operator, a viewer, a read-only console and the longest name a
token can have, with the bar read in every combination of the live pill's states, the theme button shown and hidden,
and the Parked count as drawn, emptied and five digits long. In each of those reads no two of its parts overlap and
the page does not scroll sideways; above a phone's width every pill of the navigation is wholly in view, focus ring
included; at every width, a phone's too, the bar keeps its height through all of those reads; from 1440 pixels the
bar of a console that is not read-only is one row, as the design draws it; a name or role that is cut ends in an ellipsis and
its tooltip holds it whole, and the longest name is always cut where the bar shows it; and More, opened by a click
(on a phone with its button left half scrolled out of the navigation and nothing focused, as a screen reader's
activation is), opens inside the window right under its button, its button whole. One more run opens More with the
page's script switched off and fails unless it opens under its button all the same (and unless the script really was
off, and the run was made at all). Each run first checks two top
bars built to fail, one built to break nine of its rules and a phone's bar built to break four (a jump with the last
live word and one with its Parked count emptied, a page that scrolls sideways only while the count is emptied, and a
More that shuts itself when opened with its button cut), and fails unless each fails with exactly those, so a check
that stopped seeing one of those thirteen could not pass in silence. The other rules are held by the check's own
tests.

The console works in Chrome or Edge 88, Safari 14 and Firefox 78, or newer. In an older browser parts of the look are
lost. A few details need a newer browser. Without one, some spacing and the focus ring fall back to
the browser's own. Where `:has()` is missing (before Chrome and Edge 105, Safari 15.4 and Firefox 121) the More pill is not
marked as the page you are on while you read the audit log (Audit inside the menu still is), and on a phone a wide
table on a page not yet redrawn is squeezed into the screen instead of scrolling in its box. Where
`overflow-wrap: anywhere` is missing (Safari 14 to 15.3) a long id does not break inside itself: in a panel it wraps
less neatly, and a page titled with a very long unbroken run id can scroll sideways.

### The overview

The overview leads with what may need you: the jobs running now, then the parked runs waiting for an answer. Below
them:

- **Fleet**: whether the queue is paused, partly paused or running, and the workers. A worker is online when its host
  checked in within the last minute (every worker checks in every 15 seconds). When no host has and the queue sees no
  worker connected either, the panel starts with "No worker online: jobs queue but nothing runs them", and the queue's
  state is never shown green, even when nothing is paused: jobs are accepted and wait, and nothing picks them up. A
  host's check-in age is measured with the console host's clock against the worker's, so a worker whose clock is
  behind looks staler than it is; while the queue still sees workers connected (a count with no clock in it), the
  panel says "Host beats look stale (clock skew?), but the queue still sees its workers connected" instead, and the
  queue stays green. Keep the hosts' clocks in sync (NTP) and the note goes away. The workers line says how many hosts
  are registered and how many of those are online, and how many the queue sees connected when that is more. When the
  host registry cannot be read, the page says it shows the fleet as last seen and judges nothing. "Failed jobs awaiting retry" is the queue's failed set: jobs whose last
  attempt failed, which an operator can retry or remove on the fleet page.
- **Spend against caps**: the jobs started today, this week and this month and the tokens used today, each against
  its cap ("no cap" when none is set), then each dollar window. These windows are UTC days, Monday to Sunday UTC weeks
  and UTC months, as the budget counts them, and the panel says so under them: "today" may have started at 02:00 your
  time.
- **Hosts online**, with how long ago each last checked in.
- **Problems (24h)**: the failed runs and the refused runs of the last 24 hours, each linked to the runs list, and the
  five most frequent refusal reasons, each as a short sentence linked to the runs it refused
  (`/runs?outcome=policy&reason=<reason>`). A run an operator cancelled is not counted as refused: the runs list
  shows it as cancelled, and nothing about it needs a rule changed. When every run the console read was inside the
  day, both counts say "at least".

Money in lists and on the overview is shown in one form, to the cent with thousands commas (`$1,234.56`), so the rows
of a column compare at a glance; hover it for the exact amount. An amount spent against a cap is rounded down, so a
window a fraction of a cent short of its cap never reads as the cap (and a spend under a cent reads `$0.00`); a cap
or a price is rounded to the nearest cent.

Times written out on a console page (the run lists, the run page, the fleet's schedules and failed jobs, the parked
inbox, the audit log, and the instants in the Spend page's budget split and capacity text) are in your browser's
time zone, with its UTC offset (`2026-10-08 17:39 UTC+2`); hover one for the UTC time. The console sends UTC (the same
page for every reader), and the page's script turns it into local time, so with scripts off a page reads UTC. Some
times stay UTC on purpose: the live transcript's entry times (`HH:MM:SS UTC`, to the second), the hover tips on the
Spend page's charts (they say "UTC"), the charts' day labels and daily buckets (UTC days, the budget's), and the
budget split's short "at MM-DD HH:MM" notice, which uses the panel's words. The insights file written by `/dispatch insights` runs no such script, so its times read UTC.

### Outcomes and reasons

The console and the `/dispatch` panel use the same words for how a run ended. The run record's `outcome` is
`completed`, `policy` or `failed`; both surfaces say completed, refused (for `policy`) and failed. Two reasons change
the word: a completed run with `awaiting-input` is **awaiting input**, and a run with `operator-cancel` is
**cancelled**. The record's `backend` is the **Venue**, the spend page is **Spend** (its insights are the page's
content, still at `/insights`), and the jobs held on a wait are **Held**. The query and field names stay the
record's (`outcome=policy`, `backend=`); `outcome=refused` is refused with a message naming the three values.

In the runs list, a refused or failed run shows its reason as a short sentence after the word, for example
`refused · This project's run cap for the window was already reached…`. The sentence is the reason catalog's
explanation ([reasons.md](reasons.md)), cut to fit a row: the leading verdict ("Refused:") is dropped, the first
sentence is kept, and a longer one first loses its asides (a part in parentheses, a ", which ...," clause) and is then
cut at a word with an ellipsis: never on a word like "so" or "the" (except where backing off would leave fewer than 24
characters), never on a "not" or "no" without the word before it, and never inside a parenthesis. Hover it for the reason's word itself; click it to list every run with the same outcome and
reason. A reason this console does not know (from a newer worker) is shown as its word with "no explanation yet".
Only the record's reason word is ever shown in a list, never a job's own failure text. In pi, the panel's list row
says the word and puts the reason's word last (`✘ failed · 3t · 12.3k · container-never-started`), so a narrow
terminal cuts the reason before the counts, and its run detail prints the whole sentence and the next step under the
reason. `/dispatch runs` says the same word in its OUTCOME column and the reason's word in REASON.

**The Venues panel** on `/fleet` lists every venue this release knows, and any venue a newer worker blesses that it does
not. For each one: the hosts that bless it and the ones whose default it is, each host's
`PI_BACKEND_FLOOR`, every property the venue declares (the question it answers, its word, and what the word means:
`enforced`, `asserted` or `absent`, with the switch or the check it depends on), what it serves, who holds the job's
credentials, and for the OpenShell venues each host's engine, mode and whether its gateway was on that host when
its worker started. The hosts' parts are what each worker published about itself when it started; the rest is the
release's own table.
Nothing is checked live from the console, so a word is the venue's declared one: `pi-dispatch doctor` on a host says
whether it holds there. A host running a worker older than this console shows "not published". The runs table has a
Venue column, and in pi, `/dispatch` shows the same view: `u` for the hosts, then `v`.

**Links to the forge** come from your deployment's own settings, never from a guess. A GitHub run links to
`github.com`; a GitLab, Forgejo or Azure DevOps run links to the instance URL in your `.env` (`GITLAB_URL`,
`FORGEJO_URL`, `AZURE_ORG_URL`). When that URL is not set, or the run's target does not look like a repository and a
number on that forge, the page shows the target without a link.

**A parked run** is one that ended asking a person a question (see [sessions](sessions.md)). It shows as answered
once a later run on the same issue exists, because an answer is a new delivery on that issue. "The same issue" ignores
the case of the repository path and leading zeros in the number. Until that later run ends it has no record, so the
console also looks in the queue: a park with a run queued or running on its issue is **being answered**, its Answer
column links that run, and it gets no answer form. The console reads the queue for this at most every 15 seconds
while something is parked, up to 10,000 queued and running jobs in all (it reads each job's kind and issue, never its
text). When that look cannot see everything, the column says unknown and the park gets no answer form, as the run
page's Chat panel draws none: a queue too deep to check says so ("answer it on the forge, or wait until the queue is
shorter"), because on such a queue an answer already sent can wait longer than the ten minutes in which a second one
would be dropped as a duplicate. The overview's waiting count leaves out the parks being answered and says how many there
are. The count of resumes
comes from the session store, so the console can read it only when `PI_SESSIONS_DIR` is on its own host; anywhere
else, and for a pull request (whose session the record cannot name), it shows as unknown rather than as 0.
An operator can answer an issue's parked run from this page ([Answering a parked run](#answering-a-parked-run)).

**A failed job's reason** (BullMQ's message for the attempt that failed) is the one free text the screens show. It
is the worker's own message, trimmed and cleaned, but it can still carry a fragment of something a job touched, so
only the operator role sees it, on the fleet page, in a "Why each failed" element below the failed jobs that you
open per job, never in a list row.

### The run page's outcome

A run's page starts with an **Outcome** panel, the same for a viewer and an operator: the outcome word (completed,
refused, failed, awaiting input or cancelled, in its colour), the reason's whole explanation from the reason catalog,
**What to do**, and a link to the reason's heading in [reasons.md](reasons.md) on the repository's GitHub page (the
console serves no docs of its own, and the link goes to `main`, which holds every reason a released worker can write).
Where the record's detail (`why`) says which of a reason's messages the worker posted, the panel says that one. A
reason this console does not know (from a newer worker) is shown as its word with "no explanation yet", and an
outcome word it does not know is shown as it is, cut at 64 characters.

When the page has no record to show, the Outcome panel says why, once: the id is not a run id, the run is still going
(a record is written when a run ends), the job is queued, the job ended but its record is on another host with no run
mirror, or no such run is known. The record's panels are then left out rather than each saying the same thing. A
queued or running job's sentence is a grey note (nothing is wrong, the record comes at its end); the others are
amber. A queued job's page has no live transcript section either: reload once it runs, and the section is there.

For a run waiting for an answer, **What to do** names answering from the console only where the page's Chat panel can
take the answer; when it cannot (for example, the queue no longer holds the job's data), it says to reply on the issue
or pull request instead.

A run **refused before it started** (refused, with no tokens, no exit code and no budget slot held, which is what most
refusals before any spend write) never had a container, so its page has no Progress, Chat or live transcript section.

The Session and plan panel and the Recovery row say what their words mean too: `fresh (absent): No saved conversation:
...`, the plan's reason with its sentence, and `recovery skipped (local): A folder job is never recovered, ...`.

### Doctor results

Every `pi-dispatch doctor` run publishes what it found to the deployment's Valkey, one result per host, and each
worker runs doctor itself a minute after it starts and then every `PI_DOCTOR_INTERVAL_HOURS` (24 by default; `0`
turns the worker's own runs off). The fleet page's **Doctor** panel shows each host's last result: how long ago it
ran, how many checks failed, warned and passed, and every failing and warning check with its fix, failing first. A
result older than two of that host's doctor intervals is marked stale. A live host that has published nothing is
named, so a host nobody checked never looks healthy.

What a result holds is doctor's own sentences with the private parts cut out before they leave the host: a path
becomes `<path>`, a URL keeps only its scheme and host, the value of every variable named like a secret (a token, a
key, a password) and every known token shape becomes `[redacted]`, and the file text a JSON parse error quotes becomes
`<content>`. A secret held under a name that does not look like one, with no known shape, is not recognised, so do not
rely on this to hide one. A passing check is published as its name only. A result is kept for 7 days after its last run. Both roles see
it.

When a file on the configuration page does not load (the triggers, the pause windows, the scoped limits, the projects
or the settings overlay), the sentence quotes the newest published doctor check about that file and names the host
and how long ago it ran. Without one it still says to run `pi-dispatch doctor` for the reason. Run
`pi-dispatch doctor --no-publish` to check a host without publishing. The `/dispatch` panel shows the same lines in
its hosts view (`u`).

### Run progress

Every running job shows where it is. The overview's and the fleet page's running jobs have a Progress column: the
turn, the steps done and failed, the tool running now and for how long, and the phase (2 of 4) when the job reports
phases. The run page has a Progress panel at the top: the same counters, the tools running, the last steps with how
long each took, and the phase as numbers ("Phase 2 of 4: 3 of 10 done"). An operator also sees the phase names the
agent gave, a bar for the current phase and the note the agent gave with its latest report (a report without a note
clears it); a viewer sees the numbers and the tool names only. A finished run shows the summary its run record
keeps: the turns and steps, the "Sum of step durations" (steps the agent ran side by side overlap, so this can be
longer than the run), the longest step and the "Longest interrupted step" (a step still
running when the run ended, such as a command that hung until the job timeout). A job that resumed a session shows
what the earlier runs did as "Earlier runs of this session". A job with nothing yet says "No live progress: not published
(PI_RUN_PROGRESS=0), expired, or no step has been recorded yet." The panel updates itself about every 2 seconds, so a
run page is now a live page: with the live transcript open, an operator's run tab holds two of your token's
live-page slots.

- **The counts are automatic.** They need no trigger change and no new job image: the worker reads them from the
  job's transcript.
- **Phases are opt in.** A trigger with `"progress": true` gives its jobs a `report_progress` tool, and the agent
  names its phases with it ([triggers](triggers.md#optional-run-fields)).
- **It is advisory.** The agent can write its own transcript, so a phase or a count can be wrong on purpose. Nothing
  decides anything from it.
- **Phase names and notes are the agent's words.** They are redacted like the transcript and shown to operators
  only, and never in a list, in `/api/state` or in the run record, which keeps numbers only.
- **Where it comes from**: each worker writes one small Valkey key per running job, kept 24 hours after the run
  ends. `PI_RUN_PROGRESS=0` on a worker stops it.
- **A stale job says so.** The worker rewrites a running job's key at least every 30 seconds. When it has not changed
  for 3 minutes the worker has probably stopped (a crash, a kill, a lost Valkey): the run page says "Stale: no update
  for 4 min; the worker may be gone.", the Progress column ends with "no update for 4 min; the worker may be gone",
  and the running ages stop counting.
- **A retried job.** A retry keeps the job's id. While the next attempt runs, the run page shows it live under "An
  earlier attempt of this run ended (failed); this is the attempt after it." A running job's row never shows the
  final numbers of the attempt before it.
- **A recovered run** (`run.recover`). A recovery has its own job id (`<run>.r1`), so it is not a retry: its page
  shows the run's live progress, and the page of the attempt it continues shows that attempt's own numbers with
  "This run continues as" and a link to the recovery job.

The `/dispatch` panel's running rows show the same, with the phase name clipped.

### The live transcript

An operator's run page shows what the run is doing: what the agent said, each tool it called with its arguments,
and what the tool returned, as the run goes. It works for a run on any host, because each worker publishes its
running jobs' transcripts to Valkey, and for 24 hours after the run ends. New entries appear about a second after
the agent writes them; the view follows the bottom unless you scroll up, and says whether the run is live or ended,
and how it ended. Tool calls and their results are folded; open one to read it. A viewer sees "Transcripts are shown
to operators only." A run with no transcript says "No live transcript: not published (PI_LIVE_TRANSCRIPTS=0), expired,
or not started yet."

- **Operators only.** A viewer sees a sentence saying transcripts are shown to operators, and nothing of the text.
- **It is the transcript, not the raw log.** The model's thinking is not shown, and a job's `.log`
  (`PI_CAPTURE_JOB_LOGS`) still stays on its host and is shown by no page.
- **Secrets are taken out before it leaves the worker**: the job's own tokens and keys, and anything shaped like a
  known token, read `[redacted]`. A secret the agent re-encoded is not caught, and issue text and tool output are
  shown on purpose ([`SECURITY.md`](../SECURITY.md)).
- **Long runs are trimmed**: Valkey keeps the last 2,000 entries of a run, and a long message or tool result is cut
  and marked.
- **No transcript** means one of: the worker has `PI_LIVE_TRANSCRIPTS=0`, the run has not started writing yet, or
  its transcript expired (24 hours after the end, or 7 days after the start if its worker died). The page cannot
  tell these apart and says so. Two more causes are said when they apply. A run whose record names why it had none
  (`liveSkipped`) gets that reason instead: its venue copies the job's files and does not stream the transcript back,
  its job image lacks `transcriptStderr`, or the image declares no `exitAuth`. And a run on a venue that does not
  always stream (the `openshell` copy mode, which needs an image with that capability), or a running job whose venue
  the page cannot name yet, adds "or its venue or job image does not stream it". The Progress panel follows the same
  rule, since progress is read from the live transcript. The run's own page also shows a "Steering" row when a
  steer-armed run took no message, and a "Live transcript" row when it had none, each with the reason.
- **An OpenShell run's sandbox.** A run on `openshell` or `openshell-bind` shows a "Sandbox policy" row (copy or bind
  mode, how many credential providers the sandbox was given and how many placeholders they bound) and a "Rule hosts"
  row (the hosts its network policy admitted, from your allowlist, model endpoints and the forge; up to 32 listed, the
  rest counted). A run that armed `run.secrets` shows a "Secrets profile" row with the profile's name. The `/dispatch`
  panel's run detail has the same lines. Whether an MCP server connected is not recorded on any venue, so no row says it.
- The transcript holds one of your token's live-page slots while it is open, like any live page.

The `/dispatch` panel's live tail (`l`) reads the same transcript.

## Finding runs

The runs page takes these filters in its query string. Each one is matched exactly, except `q`:

| Filter | Matches the run's |
|---|---|
| `repo` | repository, such as `acme/web` |
| `kind` | forge: `github`, `gitlab`, `forgejo`, `azure`, or `local` |
| `flow` | flow name |
| `trigger` | trigger: its position in the triggers file, or a schedule's id |
| `project` | project id |
| `host` | worker name |
| `backend` | venue, as the Venues panel on `/fleet` names it (a run recorded before venues were recorded counts as `local`) |
| `outcome` | outcome: `completed`, `policy` or `failed` (a refused or cancelled run is `policy`; any other value is refused) |
| `reason` | reason, such as `awaiting-input` or `over-budget` |
| `model` | model id |
| `q` | target, any part of it, ignoring case (`web#12`) |

For example, `/runs?kind=gitlab&outcome=failed` or `/runs?q=web%2312` (a `#` in a query is written `%23`). A value
is checked against the characters that field can hold and refused by name if it does not fit; the page never repeats
the refused value back.

**Paging** goes by time, not by position. The "older" link carries `before`, the moment of the last run on the page,
so runs that finish while you page do not shift anything or show a run twice. A page holds up to 50 runs. To keep a filter that matches almost nothing from reading the whole history in one request, one page
examines at most 2000 runs; when it stops there it says so, and its "older" link carries on from where it stopped.

The runs come from two places, merged as the panel merges them: this host's run records, and the fleet's run mirror
in Valkey, which holds every host's recent runs (see [multi-host](multi-host.md)). When the mirror cannot be reached,
the page shows this host's runs and says so. Reading the pages never changes the mirror.

## Actions

Operators can change the deployment from the pages that show it. Every action is the same two steps as any write
([Writes](#writes)): **Preview** shows exactly what will happen (a diff for a file, the list of jobs for a job
action) and **Confirm** does it. Nothing happens on a preview. If something changed in between, the confirm is
refused with "changed since the preview" and nothing is done; preview again and you see the new state. Every action
goes through the same functions as the `/dispatch` panel and the pi extension's tools, so a value the panel refuses
is refused here with the same words, and every action lands in the [audit log](#the-audit-log).

| Where | Action | What it does |
|---|---|---|
| Fleet | Cancel | Stops a running job on whichever host runs it, or removes a held one. A running job that no worker acknowledges is reported as not cancelled, never as done. |
| Fleet | Retry | Puts a failed job back in the queue. The worker runs it again from the start, through every budget check, so it can cost money. |
| Fleet | Remove | Deletes a failed job from the queue. Its run record stays. |
| Fleet | Pause, Resume | The whole fleet, as `p` and `r` do in the panel, or one queue. A fleet resume is refused while the console's environment and the deployment's `.env` name different Valkeys, as in the panel and the tools. |
| Fleet | Retry all, Remove all, Cancel all held | The bulk actions (below). |
| Parked | Answer | Sends your answer to a run that is waiting on an issue ([below](#answering-a-parked-run)). Costs money. |
| Run | Re-run | Runs the same thing again ([below](#re-running-a-run)). Costs money. |
| Run | Steer, Follow-up, Withdraw | Sends a message to a running, steer-armed job, or takes one back ([below](#steering-a-running-job)). Spends from the run's own reservation. |
| Run | Sandbox | Shows the command that opens the run's sandbox on the host ([below](#opening-a-sandbox)). |
| Configuration | Edit | Triggers, settings, pause windows, scoped limits, projects, the envelope, priorities, reverting the budget split, secret profile names, and bundle resolvers (a name, a path and a format). |

**Paid actions show what they reserve.** A re-run, an answer and a retry start a paid job, so their preview shows what the
worker will hold for it before it runs: one job from the job count, and in dollars the per-job cap (the trigger's
`maxCostUsd` or the deployment's, whichever is smaller), $0 for a job that can only call free local models, or "no
cap" when neither is set. It is the worker's own rule, so the figure is what the worker will hold, and the worker
still checks every cap when it picks the job up: a job the budget does not admit is refused then, as any job is. A
bulk retry shows each job's reserve and the sum, and "reserve unknown" for a job whose data cannot be read, never $0.
Resuming the fleet or a queue shows how many jobs are waiting to start, each of which reserves up to its own cap. A
message to a running job is paid too, but reserves nothing new: it spends from what its run already holds, and the
run's turn, dollar and token caps still bind, so its preview says so instead of showing a figure.

**Configuration edits** change the same files the panel writes (`triggers.json`, the settings overlay, the money
files) and nothing else. Nothing is committed to git: if you keep the deployment folder in git, commit the change
yourself. A secret profile is a name and the path of its resolver script, and a bundle resolver also says the format its script
prints; the console never asks for or shows a secret's value, nor a bundle's reference. A project edit refused because
a secret bundle names the project shows that refusal in the form, and nothing is written. If another session (the panel, a tool, a hand edit) wrote the file after your preview, the confirm is
refused and the file is left as it is.

### Bulk actions

Retry all failed jobs, remove all failed jobs (optionally only one queue or one repository), and cancel all held jobs.
The preview lists every job the action will touch, at most 100; when more match, it says how many more (or, for a
repository filter whose scan stopped before the end, at least how many), and you run it again for the rest. The confirm
acts on exactly that list and re-checks each job: a job that was retried, removed or failed again since the preview is
skipped and reported, and the others go ahead. The answer lists what happened to each job, and the audit log has one
line per job. A bulk retry can start up to 100 paid jobs from one confirm, each still held to every cap.

### Answering a parked run

On the parked page, an operator can type an answer under a run that is waiting on an issue and send it. The console
does not comment on the issue itself: it queues the same job a reply on the issue would have queued, through your
comment trigger, with your answer as the reply text. The run resumes from where it stopped, and reads your answer as
data, exactly as it reads a comment.

What the issue shows: once the worker has checked that the issue really is waiting, and before anything is spent, it
posts one comment as the deployment:

> Answered from the operator console by rob:
>
> > your answer, quoted

The name is your token's name. An answer from pi's [`/dispatch chat`](chat.md#in-pi-dispatch-chat) reads "Answered
from an operator's /dispatch panel" instead, so a token named `panel` is refused here: give it another name. Any
`@name` in your answer is changed so it does not notify anyone. That comment is
the record of what the agent was told, for anyone who reads the issue later.

An answer is at most 8 KiB of text; control characters are removed, and an empty answer or a longer one is refused,
never cut. The console refuses, before queueing anything, a run that is not waiting any more (answered already, or a
later run on the same issue), a run being answered right now (an answer or another run on the same issue is queued or
running), a run for which that could not be told (the queue could not be read, try again; or it holds more than
10,000 queued and running jobs, answer on the forge or wait), a run that parked on
a pull request (answer it on the forge, with your trigger phrase),
a run whose queue data has expired (31 days), and a deployment whose comment trigger would not route a reply (none for
that forge, a command, or no `run.resume`). The audit log records the run and a hash of your answer, never the text.
Answering needs a worker of the same release as the console: an older worker runs the answer but posts no comment.

### Re-running a run

Re-run on a run's page queues the same work again:

- **A local run** (from `/dispatch run` or `pi-dispatch run`) runs its folder, flow and task again on this host,
  refused when the folder has uncommitted changes, as `/dispatch run` refuses. Its queue data is kept a day after it
  completes and a week after it fails.
- **A scheduled run** fires its trigger once, as the triggers file says now, like `pi-dispatch run --trigger <id>`.
- **A forge run** runs again on the same issue as a new delivery, so it gets a new job id, on the queue the receiver
  would choose. Its issue and the trigger it matched come from its queue data (kept 31 days), but what the run may do
  (flow, model, cost cap, secret profile, image, backend) comes from that trigger as the triggers file says now, and
  the preview lists it. If the trigger was deleted, changed kind, stopped matching that label or action, or runs
  another flow, the re-run is refused: start it again from the forge.

A run whose data has expired, a `/command` run, and an answer to a parked run (answer the parked run again instead)
are refused by name. The run's page offers the re-run only where these checks pass: for a run that cannot be re-run
for one of them, or for a kind the console cannot re-run, the page says "Not offered for a re-run:" and the reason, in
the same words the preview would give. The page asks the queue for the run's data at most every 15 seconds; when it
cannot, it judges from the record alone, and then only says the data is gone once the run ended more than 8 days ago (a local run:
a week and a day) or 31 days and a day ago (a forge run, or a recovery of either kind). It looks in the same queues the
preview does, including the queue of a host that has stopped and left the host registry; when the registry or the
list of queues cannot be read, it does not conclude the data is gone, and judges from the record alone. The rest (the triggers file, the folder, the trigger now) is
checked when you press it, as before. The same issue and flow run or queued within the last 10 minutes take a forge re-run as a
duplicate, and a local or scheduled re-run within the same minute likewise; the console says so and nothing is
queued.

### Steering a running job

The page of a running job whose trigger has `steer` has an **Inbox** panel: the messages sent to the run (id, steer
or follow-up, where it came from, state, when, size), never their text, for both roles. An operator also gets a
**Steer** and a **Follow-up** form while the job is running and its run takes messages, and a **Withdraw** button on
each message that is still queued or written. The preview shows your message as the run will get it and says that it
spends from the run's existing reservation; Confirm sends it, signed with your token's name. The console refuses,
before sending, what `pi-dispatch steer` refuses (the job is not running, the run takes no messages, the text is empty
or above 8 KiB), and a confirm after the run finished is refused with nothing sent. A withdraw is guaranteed for a
queued message and best effort for a written one, and its preview says which. The audit log records the job, the
message id and a hash of the message, never the text. In the `/dispatch` panel the same is `t` (steer) and `T` (follow-up) on the
ACTIVE row, offered only while the run's inbox takes a message (a steer-armed run whose loop has not started, has
ended, or whose venue or image cannot deliver says so instead). All of it is in [`steering.md`](steering.md#from-the-console-and-the-panel).

### The Chat panel

A run's page has a **Chat** panel, between Progress and Inbox, that says what the run is (running, queued, parked,
answered by a later run, being answered, finished or unknown) and offers the chat it can have now, by the same rule
`pi-dispatch chat` uses ([`chat.md`](chat.md)):

- **A running run** (or one going on as a [recovery](durable-runs.md) job, which the panel links): a link to its live
  transcript, and the **Steer** and **Follow-up** forms while the run takes messages. The forms then move here from
  the Inbox panel, so the page never holds two of either; the Inbox panel keeps the list and the Withdraw buttons.
  A run that is not steer-armed, or whose inbox is closed, says so instead, and when the run's inbox could not be
  read at all the panel warns that it cannot tell (rather than saying "not steer-armed").
- **A parked run**: the answer form, the very one the parked page draws ([Answering a parked run](#answering-a-parked-run)),
  and a pointer to the question. The form is drawn only where the console would accept the answer: for a pull
  request's park, job data that has expired, or a comment trigger that would not route a reply, the panel shows the
  sentence the console would refuse with instead of the form (and no terminal command). When that check could not be
  read, the form stays and the panel says the preview will check again.
- **A finished run**: the command `pi-dispatch chat <job id>`, to copy and run on the host that keeps the session
  store, which opens the run's stored conversation in your own pi as a fork. When the run's trigger kept no session,
  or the run was a pull request (whose session the record cannot name), the panel says why instead.
- **Queued, unknown, answered or being answered**: one sentence saying why there is nothing to chat with. A park
  being answered links the run taking the answer, and a run whose [recovery](durable-runs.md) job is queued links
  that job.

The running and parked modes show `pi-dispatch chat <job id>` too, which opens the same chat in a terminal. A viewer sees the run's
state only, never a form or a command, and a read-only console draws no form for anyone. When the queue cannot be
read the panel says so rather than guess.

### Opening a sandbox

A run's page shows the command that reopens its sandbox, `pi-dispatch sandbox <job id>`, to copy and run in a shell on
the host that ran the job. Only for a run whose venue has a sandbox shell (`local` and `podman`): an `openshell` run says "Its workspace is not
reopenable (openshell has no sandbox shell)" instead, and an `openshell-bind` run "Its workspace is not reopenable
(openshell-bind has no sandbox shell)", the words the panel's sandbox pane uses. A run refused before it started has
no workspace, and says so. For a run of the console's own host, the page also reads the run's sandbox manifest, as the
panel's sandbox pane does, at most every 15 seconds: a workspace that was swept, never kept (retention off), moved or
belongs to another run says so instead of the command, and one past its retention window gets the command with
`--pin`. For a run of another host the console cannot see the manifest, so it shows the command and the CLI on that
host decides. The console also never decides which venues your shell may open: that is the `PI_BACKENDS` of the shell
you run the command in, which the console does not read, so a `podman` run always gets its command and
`pi-dispatch sandbox` refuses it there, by name, if that shell does not bless `podman`. The console never opens a shell or starts a container itself: a terminal in the browser
would put an interactive shell one stolen session away from anyone.

## Live updates

The overview, runs, parked, fleet and run pages update themselves while open; the run page reads its data about
every 2 seconds, for its progress ([Run progress](#run-progress)), and its live transcript streams on its own
([The live transcript](#the-live-transcript)). Insights, configuration and the audit log are drawn once per load:
their title bar says when ("Drawn at" and the time, in your own time zone once the page's script has run) and that
they are not live, beside **Reload**, which opens the same page again. The live pill in the top bar says:

- **Live** while updates arrive.
- **Reconnecting** while the connection is down (the console was killed or crashed, or the network dropped): the page
  stays as it is and the browser tries again every 2 seconds, back to Live if the console is still there. It also
  says Reconnecting when the console is stopped the ordinary way (it tells every open page as it stops) and when the
  browser has given up on the stream and the console does not answer: then a note under the title says "Console not
  reachable, retrying", and the page keeps itself, asks the console again every 2 seconds and reloads once it answers,
  if this browser is still signed in as the person the page was drawn for (signed in as someone else, it goes to the
  sign-in page, which says so; signed out, to the sign-in page, which says why).
- **Not live** until the page's script has connected (so a page without JavaScript always says so), and when the
  console refused the stream because the page was past a stream limit (below); a note then says how many live tabs
  one token may hold, with Reload.
- **Signed out** when your session ends: a note says so and the page goes to the sign-in page, which says why
  ([Sessions](#sessions)). A console that was restarted, whether stopped or killed, no longer knows your session, so
  once it answers again an open page goes to the sign-in page too, which says the console may have restarted.

When you sign out in one tab, that tab goes to the sign-in page once the console confirms it ([Sessions](#sessions)).
Every other open live tab of the same session waits 2 seconds and asks the console whether this browser is signed in
again (in another tab, say): if it is, as the same person, the tab reloads; as someone else, it goes to the sign-in
page, which says this browser is now signed in as someone else; and if it is not signed in, to the sign-in page,
which says you signed out in another tab.

**Data shown as last seen.** If the console cannot read the deployment's data for an open page (Valkey went away, for
one), the page keeps what it showed rather than fill with "could not be read": its panels are drawn flat, with no
ground of their own and a thin ring, their words as they were and each plain button given a ring of its own so it
still looks like one (each still works), under "Shown as last seen at" and the time, in your own time zone. Only the
next good read takes both back. A page whose connection drops and comes back while the data still cannot be read
stays marked, showing nothing newer than the last good read, because the console tells every connection first
whether the page is current, before it sends anything else. A page opened while the data cannot be read shows those
"could not be read" panels as before, since there is nothing older to keep. The same look shows while the console cannot
read its tokens file, and then the note says so: the console could not read its tokens file, and an operator should run
`pi-dispatch doctor` ([Sessions](#sessions)).

**A panel you are using is kept still.** While a preview is open for a panel, or you have typed into or focused one of
its fields, or its editor is open, updates to that panel wait: it says "Updates paused while you edit" and "Newer data
is waiting. It shows when you close the preview or leave the field.", and the newest update lands when you do.

Each state is a word as well as a colour, and only Live pulses; Signed out shows the sign-out mark in place of the
dot. On a phone the pill never changes size: it is one small mark whose shape says the state, a dot for Live, a retry
arrow for Reconnecting, a stop square for Not live and the sign-out arrow for Signed out, and a screen reader still
hears the word, so neither the first load (drawn Not live, then Live) nor a reconnect moves the page. The console reads
Valkey once a second for every open page together,
and only while a page is open, so ten open tabs cost the deployment what one does; the runs page, whose filters make each view its own read,
refreshes every 5 seconds. Only the parts of the page that changed are sent.

A live page holds one connection open. Each token may hold `PI_CONSOLE_MAX_STREAMS` of them (default 4) across all
its sign-ins, and the console 32 in all, of which 8 are kept for operators. A page opened past either limit still loads, but stays still until you reload it after closing
another tab; its pill then says Not live, and its note says how many live tabs one token may hold, with Reload. A
run page with its transcript open counts as two.

**An open page does not keep you signed in.** Only a page load or a request counts as activity. A page left open
signs out after `PI_CONSOLE_IDLE_MINUTES`, and its updates stop and send you to the sign-in page when:

- you sign out, in this tab or another (its updates stop at once; another tab first asks the console whether this
  browser signed in again, above);
- your token is revoked or rotated, or its role changes;
- someone runs `pi-dispatch-console sessions end-all`;
- the session passes the idle limit or `PI_CONSOLE_MAX_HOURS`.

All but sign-out take effect within a second, with no request needed. A browser that falls far behind (2 MiB of
updates it has not read) is cut off and reconnects to a fresh copy of the page.

## Error pages

When the console refuses or fails a page your browser opens, it answers with a page of its own instead of a line of
JSON: the same top bar, the same theme, a status, a sentence, and a way back. A script, the live streams, every write
and the terminal chat still get the JSON they always got, and so does anything under `/api/` or `/static/`: the page
is only for a browser's own navigation (a GET whose `Accept` asks for HTML). Every error page carries the same
security headers as every other response, and says only fixed sentences: it never repeats the address you asked for
or a value you sent.

| Status | When | What it offers |
|---|---|---|
| 404 | no page at that address | Go to Runs, Go to Overview |
| 405 | an address that takes requests from the console's own buttons, not a page | Go to Overview |
| 400 | a page refused its address (a filter or a cursor it cannot use); the sentence names the parameter and its rule | that page without its query (Runs, for a run page), and Overview |
| 403 | the audit log, for a viewer | Go to Overview |
| 421 | the console does not answer to the name in the address | the `ssh -L` command for the address and port you came in on |
| 503 | the console cannot use its tokens file right now ([Sessions](#sessions)) | `pi-dispatch doctor` to run on the host, then reload |
| 500 | the console failed on the request | reload; its log has the reason |

The 404, 405, 400 and 403 keep the navigation when you are signed in; a 404 or a 405 does not count as activity, so it
neither keeps a session alive nor ends one. The 421, 503 and 500 have no navigation: a 421's links would go to the
same name it refused, and the other two cannot vouch for the session behind the request.

The 421 shows no session data at all. It names the hostname your browser asked for (cut to 64 characters), says the
console "answers only to the names it was started with (127.0.0.1, localhost and [::1] unless more were added)",
never which names were added, and gives the tunnel to open instead, for the address and port your request reached
(`127.0.0.1` below; `[::1]` for a console listening there, or the address it listens on):

```text
ssh -L 4790:127.0.0.1:4790 '<this host>'
```

Its Copy button works only where the browser counts the page as secure, which a name other than `localhost` over
plain http never is, so there you select the command instead.

On a unix socket, which has no port, it gives `ssh -L '4790:<console socket>' '<this host>'`: put in your socket's
path, which the page does not show.

## The state API

`GET /api/state` returns the deployment's live snapshot as JSON, so a script never has to read a page. It needs a
session like every page; both roles may read it, and a viewer's copy leaves out the failed jobs' reasons. The fields
are described in `INT-CONSOLE-STATE-API` ([`specs/interfaces.md`](../specs/interfaces.md)): within its `version`,
fields are only ever added. Each running job in `active` carries a `progress` object of numbers and the running
tool's name (never a phase name or note), or null when it has none, and `steer` (whether its trigger arms steering)
with `inbox`, that job's messages as `{id, mode, source, state, at, bytes}` and never their text (null when the job is
not steer-armed or its inbox could not be read). A part the console could not read is marked with a boolean (`fleetDegraded`,
`parkedUnknown`, `unreachable`), never with the error, and when Valkey cannot be read at all the answer is `503` with
a short `error` sentence.

Sign in once with a token and keep the session in a cookie file. Never put the token on a command line, where the
process list and your shell history can see it: read it into a variable and send it on standard input instead. The
console checks that a sign-in comes from its own origin, so the request names it.

```bash
umask 077   # the cookie file holds a live session
read -rs PDC_TOKEN   # paste the token; nothing is shown
printf '{"token":"%s"}' "$PDC_TOKEN" | curl -sS -c ~/.pdc-cookies \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:4790' \
  --data-binary @- http://127.0.0.1:4790/login
unset PDC_TOKEN

curl -sS -b ~/.pdc-cookies http://127.0.0.1:4790/api/state
```

`printf` is built into the shell, so the token never becomes a process argument. On a unix socket, add
`--unix-socket /path/to/console.sock` to both commands and keep the `http://127.0.0.1:4790` part as written (the
console checks the hostname in it, not the address). The session ends like any other: after
`PI_CONSOLE_IDLE_MINUTES` without a request, or when you sign out:

```bash
curl -sS -b ~/.pdc-cookies -X POST -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:4790' --data '{}' http://127.0.0.1:4790/logout
rm ~/.pdc-cookies
```

Each parked run in `parked` carries its `jobId` as well, so a script can open it or answer it without a second
lookup. `refusals24h` is the overview's refused count beside `failures24h`: `{count, top: [{reason, count}]}`, the
runs refused in the last 24 hours (a run an operator cancelled is not counted) and the five most frequent reasons,
or null when the run history could not be read; `failures24hFloor` marks both counts as a floor. Whether a worker is
online is `hosts[].lastBeatAgeMs` with `workers`: the overview counts a host whose last beat is at most 60,000 ms
old, and says no worker is online only when none is and `workers` (BullMQ's connected workers on the shared queue,
which holds no clock; null, read as 0, when unknown) is not above zero either. With `fleetDegraded` true it judges
neither way.
Whether a park is being answered is not in `/api/state`; `/api/run` says it per run (`pendingRunOnTarget`).

`GET /api/run?id=<job id>` (or `?url=<issue or pull request link>`, which finds the newest run on that target) returns
one run and the chat it can have now: its state, `mode` (`live`, `reply`, `fork`, or null with a fixed `says`
sentence), the running job it goes on as, whether it takes messages, whether a live transcript exists, its progress
numbers, its forge link, whether a newer run on its target exists, and for a parked run the job queued or running on
its target that takes its answer (`pendingRunOnTarget`). `steer.armed` is null when the run's inbox could not be read
(unknown, not "off"). A link finds the same run whatever the case of the repository path or leading zeros in the
number, among the newest 2000 runs it searches. Both roles may read it: it carries ids, fixed
words, times and numbers only, never a record's free text, a job's data, transcript text or a session key. This is what
`pi-dispatch chat` asks. The fields are `INT-CONSOLE-STATE-API`'s.

Without a session, `/api/state` answers 401 with a JSON error, never a redirect to the sign-in page:
`{"error": "sign in first", "ended": "idle"}`, where `ended` says why the session behind your cookie ended (one of the
reasons in [Sessions](#sessions), or null), so a script can tell an expired session from a revoked token. The 401
does not clear your cookie, so asking again still says why. While the console cannot use its tokens file it answers
503 instead and leaves your cookie as it is too: wait and ask again rather than signing in. Give a script its own token, named after the script, with the `viewer` role, so the audit log names
it and a revoke ends only its access.

## Parked runs in pi

The `/dispatch` panel in pi shows the same parked runs: press `k` in the list to open the PARKED
view, with each run's target, forge, age and resume count (`?` when this host cannot see the session store). Enter
opens the run's detail. The panel and the console read the deployment
through the same code, so the two never disagree about what is waiting.

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
| `PI_CONSOLE_MAX_STREAMS` | 4 | Live pages one token may hold open across its sign-ins, 1 to 32. The whole console holds at most 32, 8 of them kept for operators. |

The console also reads, from the same deployment, `VALKEY_URL` (the queues, hosts and run mirror), `PI_LOGS_DIR`
(this host's run records and the audit log), `PI_PAUSE_WINDOWS_FILE`, the files the configuration page shows and
edits (the triggers, settings, scoped limits, projects and envelope), `PI_SESSIONS_DIR` when it is on this host (the
parked runs' resume counts) and `GITLAB_URL`, `FORGEJO_URL` and `AZURE_ORG_URL` (the forge links). The live
transcripts and the run progress come from Valkey; whether a worker publishes them is that worker's
`PI_LIVE_TRANSCRIPTS` and `PI_RUN_PROGRESS`.

`pi-dispatch chat`, the terminal client, reads two more variables, from your own shell only and never from the
deployment's `.env`: `PI_CONSOLE_TOKEN` (your token, else it asks) and `PI_CONSOLE_URL` (which console to dial, else
`PI_CONSOLE_LISTEN`). See [`chat.md`](chat.md#reference).

The design and its rejected alternatives are `DES-OPERATOR-CONSOLE` in [`specs/design.md`](../specs/design.md); the
testable rules are `REQ-CONSOLE-SECURITY`, `REQ-OPERATOR-CONSOLE-SCREENS`, `REQ-OPERATOR-CONSOLE-ACTIONS`,
`REQ-LIVE-TRANSCRIPT` and `REQ-RUN-PROGRESS` in [`specs/requirements.md`](../specs/requirements.md); the threat model and
what it does not defend are in [`SECURITY.md`](../SECURITY.md#the-operator-console).
