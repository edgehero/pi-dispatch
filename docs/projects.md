# Projects

A project groups repos and folders under one id. Every run of a member records the project's id. The cost views
group spend by it, the panel shows each project with its members and its spend, and a `project:<id>` row in
`scoped-limits.json` caps the members as one.

## Enable it

```sh
# .env
PI_PROJECTS_FILE=/absolute/path/to/projects.json
```

`pi-dispatch init` scaffolds an empty `projects.json`, and `pi-dispatch up` sets the variable to it when `.env`
gives it no value. Unset means no projects: every run records `"project": null`, and the admin's project tools
refuse to write, because the worker would read nothing they wrote.

An EMPTY value is NOT unset. The worker keeps the empty value, tries to load it and refuses to start, so fill the
line in or delete it. Doctor fails on it.

A file that does not load also refuses worker startup. A live edit that does not load keeps the last good file,
and the worker logs `projects_reload_invalid`.

## The file

```json
{
  "version": 1,
  "projects": [
    { "id": "shop", "name": "Webshop", "members": ["github:acme/web", "forgejo:acme/platform", "/srv/shop-tools"] }
  ]
}
```

- `id`: lowercase letters, digits and `-`, 1 to 32 characters. This is what a run record carries.
- `name`: optional display text. It never appears in a run record or a log line.
- `members`: one or more scopes. Write a repo with its forge (`github:owner/name`), or a folder as an absolute path.
  A bare `owner/name` is refused, because it would name that repo on every forge.

The file is refused when two projects share an id, when one scope is in two projects (both ids are named), when
`members` is empty, and when `version` is newer than this build reads.

## Edit it from pi

Ask the model in your pi session, or call the tools yourself. Every write shows you a confirm dialog first, and
is refused when no one is there to answer it.

| Tool | What it does |
|---|---|
| `dispatch_projects` | Lists each project: id, name, members, and the scoped-limits rows that cap it. |
| `dispatch_project_add` | Adds a project (`id`, `members`, optional `name`). |
| `dispatch_project_edit` | Changes a project's `name` or replaces its `members`. An empty `name` removes it. |
| `dispatch_project_delete` | Removes a project. Refused while a `project:<id>` row names it. |

- The tools write the file `PI_PROJECTS_FILE` names. They check the result with the worker's own loader, and
  replace the file in one rename, so the worker never reads half a file.
- If `projects.json` is a symlink, the tools refuse to write it. Edit the file it points to, or set
  `PI_PROJECTS_FILE` to the real path. (A write through the link would never reach the worker's file watcher, so
  the worker would keep the old projects while the tool said the change was live.)
- The file keeps its mode, owner and group. If the tool runs as another user and cannot give the new file the old
  owner, it refuses and writes nothing, so the worker never loses read access to its own file.
- A file that is there but cannot be read (a permission error, say) refuses the write. Only a missing file starts
  from no projects. The same holds for `scoped-limits.json`.
- Right before the rename, a write reads `projects.json` and `scoped-limits.json` again and compares them with what
  the change was built from, before you confirmed it. If either changed (another session wrote it, even while your
  confirm dialog was open), nothing is written and the tool says so; look again and retry. Two writes that land
  in the same instant after that check can still race, because the two files have no lock.
- An edit cannot change an id. To rename `shop` to `store`: add `store`, point the row at `project:store`, then
  delete `shop`. The row's count starts over under the new id.
- Removing a member from a capped project widens what that member may spend, because the project row no longer
  counts it. The confirm says so.
- If a scoped-limits row already names a project that is not in the file, a write that does not touch that id
  still goes through. It says `pending`: the worker applies it once its live limits no longer name that id.
  Run `pi-dispatch doctor` to see the row.

## What a run records

The worker decides a job's project when it picks the job up, and writes that id into the run record as `project`.
An edit of the file while the job runs does not change it. A retry, or a job deferred and picked up again, is
decided again: after an edit it may record the new project, and its record replaces the earlier attempt's. A run
outside every project records `null`, and so does every run recorded before projects existed. Old records are
never moved into a project.

Only a run is grouped. A webhook trigger fires for whichever repo delivers, so the trigger itself belongs to no
project.

## See the spend

- **Insights** (`/dispatch insights`): the breakdown has a "by project" list. Each bar is a project id, and the
  names sit under the list.
- **`dispatch_costs`**: `fold.byProject` has one row per id, plus `(no project)`. The `project` filter
  (`project: "shop"`) scopes the whole fold to the runs recorded under that id.
- **The panel** (`/dispatch`): press `j` for the projects view. It lists each project with its members and this
  month's spend, then the runs under no project. Press Enter on a project to show only its runs in the runs list;
  the runs divider names the filter, and Enter on the same project clears it. A run row and the run drill-in show
  the project a run recorded.
- **Dollar windows**: a `project:<id>` row's DOLLAR WINDOWS lines count the records whose `project` is that id.

All of these read the id in the record. A run recorded before projects existed is `(no project)`, even if its repo
is a member now.

## How a name is shown

A name is your own text, and the file accepts characters that change how text around them is drawn, such as a
right-to-left override. Wherever a name is shown (the panel, the insights page, a confirm, a tool result), such a
character is written out as `\u{202E}` instead, so you can see it is there and it moves nothing. The panel puts the
name last on its line, and the insights page draws it in its own isolated span, so a right-to-left name cannot
reorder the id beside it. A name never goes into a run record, a log line or the host registry.

## Capping a project

Caps live in [`scoped-limits.json`](scoped-limits.md#project-rows), never in this file. A row with the scope
`project:shop` caps every member of `shop` together:

```json
{ "version": 2, "limits": [ { "scope": "project:shop", "day": 20, "concurrent": 2 } ] }
```

- Over its `day`, `week` or `month`, a member's job is refused with reason `project-cap`.
- Over its `concurrent`, a member's job waits until a slot frees, on any host.
- Dollar windows (`dayUsd`, `weekUsd`, `monthUsd`) refuse with `dollar-cap`. Under an allocation envelope the
  project's share of the split narrows the envelope's window, and a refusal by the share is `allocation-cap`
  ([allocation](allocation.md)).
- A project row needs `"version": 2` in `scoped-limits.json`, even with counts only. The panel and the tools write it.

The row's id must be a project here. A row naming a missing project stops the worker from starting, and a live
edit that would leave one is kept out (the worker logs `scoped_limits_reload_invalid` or `projects_reload_invalid`,
naming the row and both files). The worker judges the two files together, so a project added with its row, or
renamed in both files, applies in either save order. Doctor names such a row, and the panel's limits view marks it
`not in projects.json`.

## Several hosts

Every host of one fleet must carry the same `projects.json`. Each host resolves its own jobs from its own copy,
while the project rows' counters are shared, so two different files put the same repo in two projects, depending on
which host ran it.

A folder mounted at different paths on different hosts (`/srv/shop` here, `/mnt/data/shop` there) belongs in the
one shared file under both paths: `"members": ["/srv/shop", "/mnt/data/shop"]`. Each host then matches its own
path, and the fingerprints agree.

Each host publishes a fingerprint of its projects in the host registry (`fpProjects`): the ids and a hash of each
member, never a name or a member in clear. `pi-dispatch doctor` warns and names a host whose fingerprint differs
from this host's, and a host that publishes none (an older worker) while projects are in use. A live edit shows in
the fingerprint within one heartbeat. When this host's own `projects.json` does not load, doctor fails on that and
skips the comparison.

## When projects.json is gone

- **`PI_PROJECTS_FILE` still set:** doctor fails with `PI_PROJECTS_FILE is set ... to a file the worker cannot load,
  so it REFUSES TO START: ... does not exist`. It names the file. A running worker keeps its last good projects and
  logs `projects_reload_invalid`.
- **`PI_PROJECTS_FILE` unset as well:** there are no projects, so doctor names each `project:<id>` row instead:
  `scoped limit(s) #0 (project:shop) in ... name a project that is not in the projects file -- the worker refuses to
  start`.

## Matching rules

- A folder matches by its path as written, resolved but not followed: a symlinked folder and its target are two
  separate members. List the path your triggers use.
- A local job's folder is mounted by the path it resolves to. When that resolved folder is a member of another
  project than the one its written path belongs to, or of any project when its written path is in none, the job is
  refused as `local-folder-project-changed` before anything is spent, with or without an envelope, so a link cannot
  bill one project's work to another. A resolved folder in no project is fine.
- Paths and repo names match case-sensitively. On macOS, `/SRV/x` does not match a member `/srv/x`, even though the
  file system treats them as one folder.
- A forge member names a forge kind, not an instance. Two hosts that point one forge kind at two different servers
  still put `github:acme/web` in one project.

## Limits

- Old records are never re-attributed. They fold into `(no project)`.
- A scope belongs to one project at most.
- Webhook triggers are not grouped by project, only their runs are.
- The project is decided per attempt, so a retry after an edit may record a different project.
- Hosts must carry the same file; doctor warns when they do not.
- Two admin writes approved in the same instant can still race past the re-check (no lock across the two files).

## Reference

| Piece | Value |
|---|---|
| Env var | `PI_PROJECTS_FILE` (absolute path; unset = no projects. An EMPTY value is NOT unset: the worker keeps it and refuses to start, so fill the line in or delete it, and doctor fails on it) |
| File | `{ "version": 1, "projects": [ { id, name?, members } ] }` |
| Record field | `project`: the id, or `null` |
| Caps | a `project:<id>` row in `scoped-limits.json`; refusal reason `project-cap` |
| Tools | `dispatch_projects`, `dispatch_project_add`, `dispatch_project_edit`, `dispatch_project_delete` |
| Cost views | `byProject` in `dispatch_costs` and insights; the `project` filter of `dispatch_costs` |
| Panel | `j`: the projects view; Enter filters the runs list |
| Host registry | `fpProjects`: ids and member hashes; doctor warns on a difference |
| Spec | `INT-PROJECTS-FILE-CONTRACT`, `REQ-COST-ANALYTICS`, `REQ-ADMIN-VIA-PI-EXTENSION`, `INT-HOST-REGISTRY-CONTRACT` |
