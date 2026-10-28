"""Rebuild the whole design system in design/system from these generators, then check it.

    python3 design/tools/build.py            # every card, then fix_markers, check_fixture and check
    python3 design/tools/build.py --no-check # build only

Each gen_*.py writes its cards' preview.html and README.md. gen_journeys.py runs last among them, because it cuts its
thumbnails from the other cards. fix_markers.py then sets every card's group, design status ribbon and measured
height. Edit a generator, never a card: the next build overwrites the card.

Cover/preview.html, tokens.json, components/bundle.css, README.md and design-system.json are written by hand."""
import os, subprocess, sys, pathlib

TOOLS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

# Order matters only where one generator imports another's helpers or reads its cards.
GENERATORS = [
    "gen_components", "gen_overview", "gen_runs", "gen_runs2", "gen_parked", "gen_fleet", "gen_fleet2",
    "gen_spend", "gen_spend2", "gen_triggers", "gen_config2", "gen_access", "gen_watchboard", "gen_dispatchers",
    "gen_dispatcher", "gen_sandboxes", "gen_zerotouch", "gen_answerer", "gen_guide",
    "gen_journeys",   # last: it screenshots panels of the cards above
]

# The cards hold text beyond ASCII (glyphs like the arrow and the check mark), and the tools open files without naming
# an encoding, so every child runs in UTF-8 mode: on Windows the default would be the locale's code page.
UTF8 = {**os.environ, "PYTHONUTF8": "1"}

def run(name):
    """Each generator in its own process, as `python3 gen_x.py` runs it, so module state never leaks between them."""
    r = subprocess.run([sys.executable, str(TOOLS / f"{name}.py")], cwd=TOOLS, capture_output=True, text=True,
                       encoding="utf-8", env=UTF8)
    if r.returncode:
        sys.stderr.write(r.stdout + r.stderr)
        raise SystemExit(f"{name} failed")
    print(f"built {name}")

def main():
    for g in GENERATORS:
        run(g)
    run("fix_markers")
    if "--no-check" in sys.argv:
        return 0
    bad = 0
    for check in ("check_fixture", "check"):
        r = subprocess.run([sys.executable, str(TOOLS / f"{check}.py")], cwd=TOOLS, env=UTF8)
        bad |= r.returncode
    return bad

if __name__ == "__main__":
    sys.exit(main())
