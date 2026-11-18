# Artifacts

A forge job proves more than it can say in a comment. When it starts the application it changed and takes a screenshot,
runs an end to end suite, or reads a test device's log, those files are its evidence. Committing them would put them in
the repository; leaving them in the job's own folder loses them when the job ends. pi-dispatch keeps them for you.

## What a job does

A forge job (an issue, a comment, a pull request or a merge request trigger, flow or command) gets a writable folder,
`/artifacts`. The job is told about it in one line of its instructions, and a flow can say more, such as "save a
screenshot of the page you changed to /artifacts/after.png". Nothing else is needed: whatever the folder holds when the
container ends is kept.

A local job, a scheduled job, an answer draft and a watch investigation get no such folder. A local job already writes
to its own folder.

## What is kept

The worker reads the folder once, after the container has exited, so nothing the job runs can change a file while it is
read. It keeps, in name order:

- **Only plain files at the top of the folder.** A link, a folder or a device is dropped.
- **Only plain names**: a letter or digit first, then letters, digits, dot, dash or underscore, at most 64 characters.
  The name is shown on the run page and in the job's comment as it is, so it may carry no markup, mention or link.
- **Within the limits below.** A file over the size limit, or past the count or total limit, is dropped.

Each file's type is judged by its content, never by its name: PNG, JPEG, GIF and WebP images by their signatures, text
when it is valid UTF-8 with no NUL byte, anything else a download.

**Text files are cleaned of the job's secrets** the same way its transcript is: every credential the job held is
replaced, in every spelling the transcript cleaner knows, and so is each line of a secret file the trigger granted
([secrets](secrets.md)). **Images and other files are kept as written**, because a
binary file cannot be cleaned without breaking it. One holding a job secret word for word is dropped instead. A
screenshot shows whatever the screen showed, so a flow that photographs a page with personal data on it keeps that data
here.

Nothing about a file can fail the job. What was dropped is counted by reason (`name`, `type`, `size`, `count`, `total`,
`secret`, `unreadable`), and the run's record says how many files were kept, how many bytes, and what was dropped:

```json
"artifacts": { "kept": 2, "bytes": 184213, "dropped": { "size": 1 } }
```

A run that left nothing records nothing. A retry of the same job replaces its earlier attempt's files.

## On the console

The run page's **Artifacts** card lists what a run kept: each name opens the file, an image is drawn small under its
name, text opens as text, anything else downloads, and a file that was not kept is one line with its reason. **Viewers
see the card and can open the files too**, because the evidence is for the person reviewing the pull request; an agent
token cannot. Each file is served under a policy that lets it run, load and send nothing, and only images and plain text
are shown in the browser. The console reads its own host's store, so a run another host kept files for names that host.
See [the console](console.md#a-runs-artifacts).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `PI_ARTIFACTS_DIR` | `~/.pi-dispatch/artifacts` | Where runs' files are kept, one folder per run |
| `PI_ARTIFACTS_MAX_FILES` | 20 | How many files one run may keep, at most 200. **0 turns the feature off**: no folder is made or mounted and the job is not told of one |
| `PI_ARTIFACTS_MAX_FILE_MB` | 10 | The largest one file may be, 1 to 1024 MiB |
| `PI_ARTIFACTS_MAX_RUN_MB` | 25 | The most one run may keep in all, 1 to 4096 MiB |
| `PI_ARTIFACTS_RETENTION_DAYS` | 14 | Days a run's files are kept. 0 keeps them |

A value outside its range stops the worker at start, naming the setting. Lowering the retention also applies to files
already kept: a run's files go at the earlier of the time recorded when they were kept and its start plus today's
setting. The sweep runs at start and with the other retention sweeps (`PI_SWEEP_INTERVAL_HOURS`).

These are host settings, set where the worker runs. A trigger cannot change them.

## Where it works

On the `local` (Docker) and `podman` venues, and on OpenShell's bind mode, the folder is a mount like `/workspace`.
OpenShell's copy mode leaves it out and logs `artifacts_skipped` with `venue-copies`: that venue confines the job's
writes to a fixed list of folders that must exist for every job.

## The store

Each run has a folder named after its job id, holding `files/` and a `manifest.json` that lists each file's name, size,
SHA-256, type and whether it was cleaned, and the counts of what was dropped. Folders and files are this account's
alone (0700 and 0600). The [backup page](backup.md) lists the store.

## Upgrading

The store is new, and the run record gains an optional `artifacts` field that an older reader ignores. The job image
gains the instruction file `/opt/pi-dispatch/ARTIFACTS_PROTOCOL.md`; a job on an older image still gets the folder, but
its agent is only told about it if the flow says so. See [upgrading](upgrading.md).
