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
4. `i` → the insights page opens in the browser: the budget lever, the plan verdicts, the spend
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
empty — start the stack (`docker compose -f deploy/docker-compose.yml up -d`), queue one local job, let it
finish, then record.

## Option A — vhs (recommended for a crisp GIF)

`brew install vhs` (or see its README). Save as `docs/demo.tape`:

```tape
# docs/demo.tape
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

Then: `vhs docs/demo.tape` → produces `docs/images/dispatch-demo.gif`.

**Why `Tab` and not a row of `Down`s.** Selection is one flat list, triggers first and then runs, so a blind
`Down` count only lands where you meant it against the exact fixture you recorded on. `Tab` jumps between the
first trigger and the first row below the triggers, which needs no counting. Two fixture facts still bite:
with a job **in flight** there is an ACTIVE row directly under the triggers, so `Tab` lands there instead of
on a finished run (add one `Down`, or record with the queue idle), and in a **short** terminal sections
collapse by priority (pause windows first, then settings, then triggers, then spend), which moves everything
below them. Record at the `Set Height` above, on a fixture you control.

## Option B — asciinema + agg (records a real session)

```bash
asciinema rec docs/dispatch-demo.cast --cols 120 --rows 40
#   ... do the walkthrough above, then exit the shell (Ctrl-D) ...
agg --font-size 15 --theme dracula docs/dispatch-demo.cast docs/images/dispatch-demo.gif
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
