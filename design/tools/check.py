"""Check every card the way the Design System frame shows it, in both themes, at the card's width and at 390 px.

A card fails on: an inline style= attribute, a <script>, a web font, an @import, a <link> or a url() that leaves the
page (the console's CSP allows none of them); a page wider than the card at its own width, or wider than 390 px on a
phone; a console error; or a marker height more than 60 px off the measured page. Prints one line per card and exits 1 if any card fails. Run after build.py (it runs this itself)."""
import re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shoot import harness
from paths import COMPONENTS
from playwright.sync_api import sync_playwright

def main():
    rows, failed = [], 0
    with sync_playwright() as p:
        b = p.chromium.launch()
        for d in sorted(x for x in COMPONENTS.iterdir() if x.is_dir()):
            src = d / "preview.html"
            t = src.read_text()
            m = re.match(r"<!-- @dsCard (.*?) -->", t)
            attrs = dict(re.findall(r'(\w+)=("[^"]*"|\S+)', m.group(1))) if m else {}
            W, H = int(attrs.get("width", 960)), int(attrs.get("height", 0))
            group = attrs.get("group", "").strip('"')
            body = t.split("</head>", 1)[-1]
            flags = []
            if re.search(r"\sstyle=", body): flags.append("style=")
            if "<script" in t: flags.append("script")
            if re.search(r"@font-face|@import|<link\b", t): flags.append("font or outside stylesheet")
            if re.search(r"url\(\s*['\"]?(?!#|data:)", t): flags.append("url() outside the page")
            for theme in ("dark", "light"):
                for w in ([W, 390] if d.name != "Cover" and W != 390 else [W]):
                    pg = b.new_page(viewport={"width": w, "height": 300})
                    errs = []
                    pg.on("console", lambda msg: errs.append(msg.text) if msg.type == "error" else None)
                    pg.goto(harness(src, theme).as_uri())
                    pg.wait_for_timeout(60)
                    sw = pg.evaluate("document.documentElement.scrollWidth")
                    sh = pg.evaluate("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)")
                    pg.close()
                    if sw > w: flags.append(f"{theme} {w}: {sw} wide")
                    if errs: flags.append(f"{theme} {w}: {len(errs)} console errors")
                    if theme == "dark" and w == W and H and abs(sh - H) > 60: flags.append(f"height {H} vs {sh}")
            failed += bool(flags)
            print(f"{group:<22} {d.name:<22} {W}x{H:<5} {' '.join(flags) or 'ok'}")
        b.close()
    print(f"{failed} cards with problems")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
