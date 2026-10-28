"""Where the design system lives, relative to this file, so the tools run from any checkout."""
import pathlib

TOOLS = pathlib.Path(__file__).resolve().parent
DESIGN = TOOLS.parent                      # design/
SYSTEM = DESIGN / "system"                 # what the Design System artifact publishes
COMPONENTS = SYSTEM / "components"         # one folder per card, plus bundle.css
TOKENS = SYSTEM / "tokens.json"
BUNDLE = COMPONENTS / "bundle.css"
SHOTS = DESIGN / ".shots"                  # screenshots and harness pages; ignored by git
SHOTS.mkdir(exist_ok=True)
