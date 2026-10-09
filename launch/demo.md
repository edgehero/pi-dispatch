# Recording the demo (GIF / video)

The `/dispatch` panel is the hook — a short recording of it is worth more than any paragraph. This is the
recipe; it needs a real terminal, so it's yours to run (the panel can't be driven headless). Two options:
[`vhs`](https://github.com/charmbracelet/vhs) (scripted, reproducible, best for a clean GIF) or
[`asciinema`](https://asciinema.org) + [`agg`](https://github.com/asciinema/agg) (records a real session).

## What to show (≈ 20–30s)

1. `pi install npm:@edgehero/pi-dispatch-admin`, then `/dispatch`, for the live panel's six sections: status
   header, spend & limits, triggers, pause windows, runs, settings. (From a checkout the dev form is
   `pi -e admin/src/index.ts`; the published extension's entry point is its built `./dist/index.mjs`.)
2. `↵` on a trigger → the MATCHES / RUNS / TRUST MODEL drill-in.
3. `↵` on a run → the colored post-mortem.
4. `i` → the insights page opens in the browser: the budget lever, the plan verdicts, how busy each host was, the spend
   charts and the topology, one page. (In a pure-terminal recording, skip this beat or show the
   printed `file://` URL instead.)
5. (optional) `w` on the dashboard → the pause-window dialogs: a three-way select (add / edit / delete a
   pause window), then seven prompts for an add. Watch a PAUSE WINDOWS row flip to
   `● paused · resumes in …`.
6. `q` to close.

The footer is the shot list, in order:
`↑↓ open · a add · w pauses · l logs · i insights · p/r pause · q quit`

If the recording is for **onboarding** rather than for the README, lead with `/dispatch setup` instead: the
guided wizard is the front door now, and a panel that opens already configured is the payoff shot.

Run against a deployment with a little state (a couple of triggers, a finished run or two) so the panel isn't
empty: start the stack (`docker compose --env-file .env -f deploy/docker-compose.yml up -d`), queue one local job, let it
finish, then record.

## Option A — vhs (recommended for a crisp GIF)

`brew install vhs` (or see its README). Save as `launch/demo.tape`:

```tape
# launch/demo.tape
Output docs/images/dispatch-demo.gif
Set FontSize 15
Set Width 1200
Set Height 760
Set Theme "Dracula"
Set Padding 16

Hide
# Assumes the extension is installed: pi install npm:@edgehero/pi-dispatch-admin
# From a checkout, swap the next line for:  Type "pi -e admin/src/index.ts"
Type "pi"  Enter
Sleep 3s
Show

Type "/dispatch"  Enter
Sleep 3s
Enter  Sleep 3s   Escape Sleep 1s                      # a trigger drill-in (selection starts on trigger 1)
Tab  Sleep 500ms  Enter  Sleep 3s  Escape Sleep 1s     # a run post-mortem (Tab jumps triggers <-> runs)
Type "i"  Sleep 4s                                        # the insights page opens (browser beat)
Type "q"
Sleep 1s
```

Then: `vhs launch/demo.tape` → produces `docs/images/dispatch-demo.gif`.

**Why `Tab` and not a row of `Down`s.** Selection is one flat list, triggers first and then runs, so a blind
`Down` count only lands where you meant it against the exact fixture you recorded on. `Tab` jumps between the
first trigger and the first row below the triggers, which needs no counting. Two fixture facts still bite:
with a job **in flight** there is an ACTIVE row directly under the triggers, so `Tab` lands there instead of
on a finished run (add one `Down`, or record with the queue idle), and in a **short** terminal sections
collapse by priority (pause windows first, then settings, then triggers, then spend), which moves everything
below them. Record at the `Set Height` above, on a fixture you control.

## Option B — asciinema + agg (records a real session)

```bash
asciinema rec launch/dispatch-demo.cast --cols 120 --rows 40
#   ... do the walkthrough above, then exit the shell (Ctrl-D) ...
agg --font-size 15 --theme dracula launch/dispatch-demo.cast docs/images/dispatch-demo.gif
```

An `.cast` file can also be uploaded to asciinema.org and embedded (autoplaying) in the README.

## Where the output goes

- **README**: add the GIF near the top, under the existing SVG panel images.
- **Social preview** (GitHub → Settings → General → Social preview): export a single crisp PNG frame of the
  panel — reuse `docs/images/dispatch-dashboard.svg` rendered to PNG until the GIF exists.
- **pi.dev gallery card**: `admin/package.json` already carries `pi.image` (the banner PNG) next to
  `pi.extensions` and `pi.skills`; repoint it at a panel frame, or add a `pi.video` field with a hosted
  `.mp4`/`.gif` URL. `pi.video` would be **new** here (nothing in this repo sets it today), so check pi's own
  manifest schema before relying on it. The rest of the manifest is described in
  [launch-kit.md](launch-kit.md#packaging-the-extension), and submission context is in the same file.

Keep the file small (< ~3 MB): trim to ~25s, cap width at ~1200px, and prefer the GIF for GitHub autoplay.

## The CLI transcript images

`docs/images/cli-init.svg`, `cli-up.svg`, `cli-doctor.svg` and `cli-service-windows.svg` are real command
output drawn as a terminal window by `launch/transcript-svg.mjs`. Regenerate them when the output changes:

1. On a Linux host with Docker, as a throwaway account `you` (uid 1000) that is in the `docker` group and has
   nothing listening on 127.0.0.1:6379, and with `pi-job:latest`, `valkey/valkey:8` and the egress proxy
   image already pulled (so no pull progress lands in the transcript):
   - `pi-dispatch init > init.txt` in an empty folder.
   - `pi-dispatch up --yes > up.txt 2>&1` in an empty `~/pi-work`, with a pi login holding a dummy
     Anthropic key in `~/.pi/agent/auth.json`, so the folded doctor ends ready.
   - `pi-dispatch doctor > doctor.txt 2>&1` in the same folder, after removing that pi login, setting a
     dummy `ANTHROPIC_API_KEY` in `.env`, and adding a github label trigger with flow `fix` and a
     `run.skillsDir` of `~/pi-work/skills` holding one skill. No gh login, so its warning shows.
2. Replace the account's home with `~` in each file. Nothing else in them names the host:

   ```sh
   sed -i -e 's#/home/you/#~/#g' -e 's#/home/you\b#~#g' init.txt up.txt doctor.txt
   ```

   This turns `/home/you/pi-work` into `~/pi-work` and `/home/you/.pi-dispatch` into `~/.pi-dispatch`.
   Keep `/tmp/pi-dispatch-1000` (the jobs dir of uid 1000) and `HOME=/home/pi` (the job container's home,
   not the host's) as printed.
3. Render:

   ```sh
   node launch/transcript-svg.mjs --fit --title "~/pi-work · pi-dispatch init" --prompt '$ pi-dispatch init' init.txt > docs/images/cli-init.svg
   node launch/transcript-svg.mjs --fold-doctor --title "~/pi-work · pi-dispatch up --yes" --prompt '$ pi-dispatch up --yes' up.txt > docs/images/cli-up.svg
   node launch/transcript-svg.mjs --title "~/pi-work · pi-dispatch doctor" --prompt '$ pi-dispatch doctor' doctor.txt > docs/images/cli-doctor.svg
   ```

4. Bump the `?v=` on each changed image in the README, so GitHub's image cache fetches the new one.

`cli-service-windows.svg` is `service render` with `platform: "win32"` and Windows paths passed through
`runService`'s seams, titled `PowerShell · C:\Users\you\pi-work`.

## The panel and insights images

`docs/images/dispatch-dashboard.svg`, `dispatch-hosts.svg`, their `.png` copies and `insights-view.png` are drawn by
the shipped code over one canned deployment, by a committed script:

```sh
node launch/render-images.mjs          # the two SVGs
node launch/render-images.mjs --png    # also the two PNGs (for the npm page) and insights-view.png
```

What it needs:

- `valkey-server` or `redis-server` on PATH. The script starts its own on a free port of 127.0.0.1, with no
  persistence and its files in a temporary directory, and stops it at the end. `--url redis://host:port/<db>` uses
  an existing database instead; it must be empty, and is emptied again when the script ends.
- Google Chrome, for `--png` only: `/Applications/Google Chrome.app/...` on macOS, or set `CHROME` to its executable.
  It is driven headless over its DevTools pipe, with every host name mapped to nothing.
- git, for `--png` only (the insights topology reads the two job folders' flow gate from git).

The deployment is `launch/fixture-deployment.mjs`: three hosts (`mini1`, `mini2`, `build3`), four projects (`web`,
`api`, `billing`, `ops`), repos under `acme`, a month of run records, all dated around one frozen instant and written
through the worker's own record, mirror, registry, budget, wait and allocation code. Its config and its records agree:
no run breaks a cap, a scoped limit, a host's slots or budget, or a project's share. build3 keeps its own logs for 7
days and trims the shared run mirror by them, so its history here starts at the age cutoff of its last trim that
removed a run (that write's time less 7 days), and the insights page hatches the time before as no data. The script empties its
environment before anything loads, so no key or deployment of the machine running it is read, and nothing is fetched.
Only the queue's live counts, its workers, the active job and the failed job are canned. The dashboard is
`makeDashboard`'s LIST at width 80, the hosts image the same panel after `u`; each SVG is checked against the
renderer's lines before it is written, and two runs write the same bytes (`admin/test/render-images.test.mjs`). The
insights page is `insightsCommand`'s, shot at 1240 px and device scale 2, full page, with the browser's clock one
minute after the page was generated.

After a render, bump the `?v=` on each changed image in both READMEs (the admin README links the PNGs by their
absolute raw.githubusercontent.com URLs, because the npm page cannot show an SVG from there).
