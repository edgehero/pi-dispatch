# The console design system

The design of pi-dispatch's operator console (issue #737), in the Pulse style: every page of the console, the planned and proposed pages, the components they are built from, and guide cards that show how it fits together. `system/` is what the Design System artifact publishes; `tools/` builds it.

## What is here

| Path | What it is |
|---|---|
| `system/README.md` | The system's own guide: the screens by group, workflows, coverage of the console, voice, colour, type, components |
| `system/tokens.json` | Colour, space, radius and type tokens for light and dark |
| `system/components/bundle.css` | The one stylesheet every card is drawn with |
| `system/components/<Card>/` | One card: `preview.html` (the screen) and `README.md` (how a person uses it, its panels, what the server provides, who sees what, why it works this way, and which data is sample). Cover is written by hand and has no README |
| `system/design-system.json` | The artifact's index and its last change |
| `tools/gen_*.py` | The generators: each writes its cards |
| `tools/pulse.py`, `tools/common2.py` | The page kit: the shell, the icons and the shared parts |
| `tools/fixture.py` | The sample deployment every card draws |
| `tools/build.py` | Rebuilds every card, then checks them all |

## Rebuilding

Edit a generator, never a card: the next build overwrites the card.

```bash
pip install playwright==1.56.0 pillow==12.3.0  # Python 3.12 or newer
python3 -m playwright install chromium
python3 design/tools/build.py          # about a minute
```

The build runs every generator, then `fix_markers.py`, which sets each card's group, its design status ribbon and its measured height. Then it runs two checks, and fails if either finds a problem:

- `check_fixture.py` names any card that draws a run with another target, host or venue than `fixture.py`, or a venue its host does not run.
- `check.py` opens every card in both themes, at its own width and at 390 px. It fails on an inline `style=` or a `<script>` (the console's CSP allows neither), a page wider than its card, a console error, or a marker height more than 60 px off.

Screenshots and the harness pages go to `design/.shots/`, which git ignores. `python3 design/tools/shoot.py RunLive RunLive:390` shoots single cards.

## The rules the cards keep

- **The console's CSP.** No inline styles, no scripts, no web fonts. SVG positions are attributes. A page's own rules live in its `<style>`.
- **A design status on every screen card.** *Built* names the pull request that shipped it, *Planned* the issue that will build it, *Proposed* its issue if it has one, and *Needs a decision* the issue that decides it. The list is `STATUS` in `fix_markers.py`. Guide and component cards carry none.
- **The screen, not the argument.** Why a screen works the way it does belongs in its README, under *Why it works this way*.
- **One sample deployment.** Every name, id and time comes from `fixture.py` or agrees with it.
- **Words.** Sentence case, glyph and word for every state, no dashes as punctuation, UTC times.

## How the console uses it

The console does not read this folder at runtime. It pastes `tokens.json` and `components/bundle.css` into `admin/src/console/pulse-tokens.mjs` and `pulse-css.mjs`, each pinned by its content hash (`DES-OPERATOR-CONSOLE`, "The visual system"). A change to the look lands here first and is pasted by a console pull request. `admin/test/design-folder.test.mjs` says whether the two agree: the tokens are the same file, and the stylesheet is either the same or exactly the version recorded as waiting to be pasted.
