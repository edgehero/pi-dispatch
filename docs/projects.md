# Projects

A project groups repos and folders under one name. Every run of a member records the project's id, so you can
see which runs belong together, and a `project:<id>` row in `scoped-limits.json` caps the members as one. The cost
views and the panel come in a later release.

## Enable it

```sh
# .env
PI_PROJECTS_FILE=/absolute/path/to/projects.json
```

`pi-dispatch init` scaffolds an empty `projects.json`, and `pi-dispatch up` sets the variable to it when `.env`
gives it no value. Unset means no projects: every run records `"project": null`.

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

## What a run records

The worker decides a job's project when it picks the job up, and writes that id into the run record as `project`. An
edit of the file while the job runs does not change it. A retry, or a job deferred and picked up again, is decided
again: after an edit it may record the new project, and its record replaces the earlier attempt's. A run outside every
project records `null`, and so does every run recorded before projects existed. Old records are never moved into a
project.

Only a run is grouped. A webhook trigger fires for whichever repo delivers, so the trigger itself belongs to no
project.

## Capping a project

Caps live in [`scoped-limits.json`](scoped-limits.md#project-rows), never in this file. A row with the scope
`project:shop` caps every member of `shop` together:

```json
{ "version": 1, "limits": [ { "scope": "project:shop", "day": 20, "concurrent": 2 } ] }
```

- Over its `day`, `week` or `month`, a member's job is refused with reason `project-cap`.
- Over its `concurrent`, a member's job waits until a slot frees, on any host.
- Dollar windows (`dayUsd`, `weekUsd`, `monthUsd`) need `"version": 2` and refuse with `dollar-cap`.

The row's id must be a project here. Add the project before its row, and remove the row before you remove the
project: a row naming a missing project stops the worker from starting, and a live edit of either file that would
leave one is kept out (the worker logs `scoped_limits_reload_invalid` or `projects_reload_invalid`). Doctor names
such a row.

## Matching rules

- A folder matches by its path as written, resolved but not followed: a symlinked folder and its target are two
  separate members. List the path your triggers use.
- Paths and repo names match case-sensitively. On macOS, `/SRV/x` does not match a member `/srv/x`, even though the
  file system treats them as one folder.
- Every host of one fleet must carry the same `projects.json`. Each host resolves its own jobs from its own copy, so
  two different files put the same repo in two projects, depending on which host ran it.

## Reference

| Piece | Value |
|---|---|
| Env var | `PI_PROJECTS_FILE` (absolute path; unset = no projects. An EMPTY value is NOT unset: the worker keeps it and refuses to start, so fill the line in or delete it, and doctor fails on it) |
| File | `{ "version": 1, "projects": [ { id, name?, members } ] }` |
| Record field | `project`: the id, or `null` |
| Caps | a `project:<id>` row in `scoped-limits.json`; refusal reason `project-cap` |
| Spec | `INT-PROJECTS-FILE-CONTRACT` |
