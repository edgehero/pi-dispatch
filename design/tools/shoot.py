"""Render previews the way the Design System frame does (tokens.css + bundle.css preloaded, data-theme set) and screenshot."""
import sys, re, pathlib
from playwright.sync_api import sync_playwright

from paths import COMPONENTS, SHOTS, BUNDLE
import tokens_css  # writes SHOTS/tokens.css from tokens.json, the stand-in for the frame's compiler

def harness(src: pathlib.Path, theme: str) -> pathlib.Path:
    text = src.read_text()
    text = re.sub(r"^<!--.*?-->\n", "", text, count=1)
    text = text.replace("<html lang=\"en\">", f"<html lang=\"en\" data-theme=\"{theme}\">", 1)
    if "data-theme" not in text:
        text = text.replace("<html>", f"<html data-theme=\"{theme}\">", 1)
    inject = f'<link rel="stylesheet" href="file://{SHOTS}/tokens.css"><link rel="stylesheet" href="file://{BUNDLE}">'
    text = text.replace("<head>", "<head>" + inject, 1)
    out = SHOTS / f"{src.parent.name}-{theme}.html"
    out.write_text(text)
    return out

def main():
    names = sys.argv[1:]
    width = 1440
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name in names:
            w = width
            if ":" in name:
                name, w = name.split(":"); w = int(w)
            src = COMPONENTS / name / "preview.html"
            for theme in ("dark", "light"):
                h = harness(src, theme)
                pg = b.new_page(viewport={"width": w, "height": 900}, device_scale_factor=1)
                errs = []
                pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
                pg.goto(f"file://{h}")
                pg.wait_for_timeout(150)
                sw = pg.evaluate("document.documentElement.scrollWidth")
                sh = pg.evaluate("document.documentElement.scrollHeight")
                pg.screenshot(path=str(SHOTS / f"{name}-{theme}-{w}.png"), full_page=True)
                print(f"{name} {theme} {w}: scroll {sw}x{sh}", "errors:" + ";".join(errs) if errs else "")
                pg.close()
        b.close()

if __name__ == "__main__":
    main()
