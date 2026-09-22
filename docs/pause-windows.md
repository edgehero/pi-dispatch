# Quiet hours — scoped pause windows

Pause a **specific folder or repo's** runs *between certain times* — recurring daily, restricted to certain
weekdays or a date range, in a timezone of your choice — and resume automatically after. A paused job is
**deferred, never dropped**: it waits in the queue and runs once the window ends.

This is distinct from the global pause (`pi-dispatch pause` / `/dispatch` `p`), which stops the **whole**
queue with no schedule. Scoped pause windows are per-scope and timed, and the two compose — a scope can be
inside a pause window while the rest of the queue keeps draining.

## Enable it

Point `PI_PAUSE_WINDOWS_FILE` at a JSON file. **For the worker, unset means the feature is off**: nothing is
defaulted, and no windows are read.

```bash
# .env
PI_PAUSE_WINDOWS_FILE=/absolute/path/to/pause-windows.json
```

```json
{
  "windows": [
    { "scope": "acme/web", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam" }
  ]
}
```

The worker validates the file at boot (a malformed file **refuses startup**, fail-loud) and **live-reloads**
it on change — an edit takes effect on the next job without a restart, and a bad edit keeps the last-good
windows. Two files in this repo to know apart: `pi-dispatch init` scaffolds an **empty**
`./pause-windows.json` (`{ "windows": [] }`) in the deployment folder, and `pause-windows.example.json` at
the repo root is the **populated** example to copy windows out of.

### Set the variable, even though two other things behave as if you had

Three parts of the system decide on this path independently, and only one of them treats unset as off:

| Who | What it uses when `PI_PAUSE_WINDOWS_FILE` is unset |
|---|---|
| **The worker**, the only thing that actually defers a job | nothing: **the feature is off**, no windows are loaded |
| `pi-dispatch init` | **scaffolds** `./pause-windows.json` and leaves the variable **commented out** in `.env` |
| **The `/dispatch` panel** (and the `dispatch_pause_*` tools) | defaults to `./pause-windows.json` in **the panel's own cwd**, so it works from a deployment folder with no env wiring |
| `pi-dispatch up` | **sets the variable** in `.env` to the `pause-windows.json` in the folder it runs in, if `.env` does not already give it a value |

Each is defensible alone. Together they compose into one silent trap: run `init`, then manage quiet hours
through the panel, and you are editing a file **the worker never reads**. The panel answers
`pause window added (live)`, the JSON on disk is correct, and nothing ever pauses.

So set the variable, to an **absolute** path, in the worker's own environment, and make sure the panel
resolves the same file (export it there too, or let `/dispatch setup` write a **deployment pointer**:
`PI_PAUSE_WINDOWS_FILE` is on the pointer's env allowlist precisely so a panel started anywhere can find the
worker's files). `pi-dispatch up` does the same thing for a deployment folder, and the
row above says so; the warning below is what an `init`-without-`up` deployment still sees.

`pi-dispatch doctor` **warns on this exact mismatch**, a `pause-windows.json` in its cwd
while the variable is unset, and says the worker ignores it so scoped pauses are off. It warns rather than
fails, and offers no `--fix`, because only you know which path was meant.

**An EMPTY value is not an unset one**, and doctor says so separately, because the worker treats them
differently: the config reads this key with `??`, so `PI_PAUSE_WINDOWS_FILE=""` survives, and the worker
then tries to load a pause-windows file at that empty path and **refuses to start**. `pi-dispatch up` leaves
such a line alone (it never clobbers a value you wrote) and names it in its summary. Fill it in, or delete
the line.

One softening is worth knowing about, because otherwise it reads as the check going quiet. Doctor reads the
`.env` **in its own working directory** for this one key. If the file sets it while your shell does not, the
line changes to say that the service reads it and this command does not, and points at
`set -a; . ./.env; set +a` for a look with the environment the service actually gets. It is still a warning:
in the shell you typed it in, the feature genuinely is off. That read is narrowed to the keys these two
checks name and decides only what doctor **says**; nothing in this project loads `.env` into a process.

## The window schema

| Field | Required | Meaning |
|---|---|---|
| `scope` | **yes** | What the window applies to: the job's **repo path** on **any** forge (GitHub, GitLab, Forgejo, Azure DevOps), the **folder** host path for a local/cron job, or `"*"` for **all** scopes. Matched exactly, so mind the segment count: GitHub and Forgejo are `owner/name`, but a GitLab project is `group/subgroup/project` and Azure DevOps is `org/project/repo`. The rule is just local → folder, anything else → repo, so a forge added later is scoped automatically. |
| `from` | **yes** | Pause **start**, `"HH:MM"` 24-hour. |
| `to` | **yes** | Resume time, `"HH:MM"` 24-hour. If `from > to` the window is **overnight** (spans midnight). `from == to` is rejected — a 24h pause isn't expressible; remove the trigger instead. |
| `tz` | no (default `UTC`) | IANA timezone, e.g. `"Europe/Amsterdam"`, `"America/New_York"`. `from`/`to` are that zone's wall clock, DST-correct. |
| `days` | no (default: every day) | Weekday allow-list, e.g. `["mon","tue","wed","thu","fri"]`. Gates the day the window **starts** — an overnight window that starts on an allowed day still runs into the next morning. |
| `dateFrom` | no | Inclusive `"YYYY-MM-DD"`: the window applies only on/after this **start** date. |
| `dateTo` | no | Inclusive `"YYYY-MM-DD"`: only on/before this start date. |

## Examples

**Daytime freeze (same-day window)** — pause a repo 09:00–17:00 UTC:
```json
{ "scope": "acme/web", "from": "09:00", "to": "17:00" }
```

**Overnight quiet hours** — pause a folder every night 22:00 → 06:00 in Amsterdam time (`from > to` = overnight):
```json
{ "scope": "/srv/site", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam" }
```

**Weeknights only** — the overnight window, but only when it *starts* on a weekday:
```json
{ "scope": "acme/web", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam",
  "days": ["mon","tue","wed","thu","fri"] }
```

**A change-freeze between dates**: `acme/api` frozen across a release window. Note the shape, `00:00` to
`23:59` is a same-day window matched as `[from, to)`, so it leaves the final minute (`23:59`) **open**, and
`from == to` is rejected by design, which means a true 24-hour window is not expressible in one entry. Either
accept that minute or lay down two adjacent windows:
```json
{ "windows": [
  { "scope": "acme/api", "from": "00:00", "to": "12:00", "dateFrom": "2026-08-10", "dateTo": "2026-08-14" },
  { "scope": "acme/api", "from": "12:00", "to": "00:00", "dateFrom": "2026-08-10", "dateTo": "2026-08-14" }
] }
```

**Everything, on weekends** — pause all scopes on Saturday/Sunday nights:
```json
{ "scope": "*", "from": "20:00", "to": "08:00", "days": ["sat","sun"] }
```

**Multiple windows** — they're independent; a job is paused if it falls inside *any* matching window, and held until the latest one ends:
```json
{ "windows": [
  { "scope": "acme/web", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam" },
  { "scope": "/srv/site", "from": "09:00", "to": "17:00" }
] }
```

## How it works

- **Deferred, not dropped.** When a job is picked up and its scope is inside an active window, the worker moves
  it to the queue's **delayed** set until the window ends (via BullMQ's `moveToDelayed`), then it runs
  automatically. It keeps its identity (so GitHub delivery-GUID dedup still holds) and survives a worker restart.
- **Zero cost while paused.** The check runs **before** the budget reservation, so a deferred job reserves no
  spend slot and counts nothing against your daily/weekly/monthly caps — a deferral is not a job start.
- **Timezone-correct.** Wall-clock times are resolved in the window's `tz` using the runtime's built-in
  timezone data (DST-correct), with no extra dependency.

## Managing windows

Three equivalent ways, all writing the same validated file and taking effect live, **provided the panel and
the worker resolve `PI_PAUSE_WINDOWS_FILE` to the same path** (see [Enable it](#enable-it) above):

1. **Edit the file.** Change `pause-windows.json`; the worker hot-reloads it (keeps the last-good set on a bad edit).
2. **In the panel.** Open `/dispatch`, press `w` → **add, edit, or delete** a window through operator
   dialogs. Editing re-prompts each field with its current value, so a blank answer keeps it and you only
   re-type what changes. The **PAUSE WINDOWS** section shows each window as `●` paused (with a resume
   countdown) or `○` open.
3. **From an agent, human-gated.** The model tools `dispatch_pause_add` / `dispatch_pause_edit` /
   `dispatch_pause_delete` (and the read-only `dispatch_pauses`) let an agent manage windows — edit is a
   **partial** change (pass only the fields to alter; the rest keep their value) — but each write **pops an
   operator confirmation the model can't answer**, and is refused when no operator is present.

## Caveats

- A window edited or removed **while a job is already delayed** doesn't re-time that job — it wakes at its
  original window-end and the gate re-checks then. (You can also promote delayed jobs manually via the queue.)
- `from == to` is rejected on purpose. To pause a scope indefinitely, remove its trigger rather than express a
  24-hour window.

## Reference

The internal specs: `REQ-SCOPED-PAUSE-WINDOWS` ([requirements](../specs/requirements.md)),
`DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED` ([design](../specs/design.md)),
`INT-PAUSE-WINDOWS-FILE-CONTRACT` ([interfaces](../specs/interfaces.md)).
