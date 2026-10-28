"""Local stand-in for the page's tokens.css compiler (for screenshots only; never published)."""
import json
from paths import TOKENS, SHOTS
t = json.load(open(TOKENS))
themes = [th["id"] for th in t["color"]["themes"]]
first = themes[0]

def val(v):
    return f"var(--{v[1:-1]})" if v.startswith("{") else v

out = []
for i, th in enumerate(themes):
    sel = f':root, [data-theme="{th}"]' if i == 0 else f'[data-theme="{th}"]'
    lines = []
    for tok in t["color"]["tokens"]:
        v = tok["value"]
        v = v.get(th, v.get(first)) if isinstance(v, dict) else v
        lines.append(f"  --{tok['name']}: {val(v)};")
    for tok in t.get("shadow", {}).get("tokens", []):
        v = tok["value"]
        v = v.get(th, v.get(first)) if isinstance(v, dict) else v
        lines.append(f"  --{tok['name']}: {v};")
    out.append(sel + " {\n" + "\n".join(lines) + "\n}")
lines = []
for fam in ["spacing", "radius", "layout"]:
    for tok in t[fam]["tokens"]:
        lines.append(f"  --{tok['name']}: {tok['value']};")
for k, v in t["type"]["families"].items():
    lines.append(f"  --font-{k}: {v};")
out.append(":root {\n" + "\n".join(lines) + "\n}")
for g in t["type"]["groups"]:
    for s in g["styles"]:
        fam = s.get("family", g["family"])
        decl = [f"font-family: var(--font-{fam})", f"font-size: {s['fontSize']}", f"line-height: {s['lineHeight']}", f"font-weight: {s['fontWeight']}"]
        if "letterSpacing" in s: decl.append(f"letter-spacing: {s['letterSpacing']}")
        out.append(f".{s['name']} {{ " + "; ".join(decl) + "; }")
open(SHOTS / "tokens.css", "w").write("\n".join(out) + "\n")
print("ok")
