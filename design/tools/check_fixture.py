"""Name every card that draws a run differently from fixture.py: another target, host or venue for the same id, or a
venue its host does not run. Run after the generators: python3 check_fixture.py [Card ...]. Exit 1 on a mismatch.

It reads each card's visible text in small chunks (a list item, a table row, a paragraph) and judges a chunk only when
it names exactly one run id, so a row about one run is checked against that run alone. Ids the fixture does not know
are listed once, as a hint, and do not fail the check."""
import re, sys, html, pathlib, collections
from fixture import RUNS, OTHER_RUNS, HOSTS

from paths import COMPONENTS as ROOT
ID = re.compile(r"\b(?:gh|gl|fj|az)-[0-9a-f]{4}(?:-r\d)?\b|\bsb-[0-9a-f]{4}\b")
TGT = re.compile(r"acme/[a-z-]+[#!]\d+")
HOST = re.compile(r"\b(mini1|mini2|build3)\b")
VTAG = re.compile(r'<span class="vtag">([a-z-]+)</span>')

def chunks(text):
    text = re.sub(r'<svg class="sprite".*?</svg>', "", text, flags=re.S)
    for raw in re.split(r"</(?:li|tr|p|h1|h2|dd)>", text):
        vis = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", raw)))
        yield raw, vis

def main(names):
    bad, unknown = [], collections.defaultdict(set)
    cards = names or sorted(d.name for d in ROOT.iterdir() if (d / "preview.html").exists())
    for card in cards:
        for raw, vis in chunks((ROOT / card / "preview.html").read_text()):
            ids = set(ID.findall(vis))
            if len(ids) != 1:
                continue
            (jid,) = ids
            row = RUNS.get(jid) or OTHER_RUNS.get(jid)
            if row is None:
                unknown[jid].add(card); continue
            _, target, _, host, venue, _ = row
            tg = set(TGT.findall(vis))
            if target and target.startswith("acme/") and tg and target not in tg:
                bad.append(f"{card}: {jid} drawn on {', '.join(sorted(tg))}, the fixture says {target}")
            hs = set(HOST.findall(vis))
            if host and len(hs) == 1 and host not in hs:
                bad.append(f"{card}: {jid} drawn on host {hs.pop()}, the fixture says {host}")
            vs = set(VTAG.findall(raw))
            if venue and len(vs) == 1 and venue not in vs:
                bad.append(f"{card}: {jid} drawn on venue {vs.pop()}, the fixture says {venue}")
            if len(hs) == 1 and len(vs) == 1:
                h, v = next(iter(hs)), next(iter(vs))
                if v not in HOSTS[h][0]:
                    bad.append(f"{card}: {jid} drawn on {v} on {h}, which runs {', '.join(HOSTS[h][0])}")
    for line in sorted(set(bad)):
        print("MISMATCH", line)
    if unknown:
        print("not in fixture.py (a hint):", "; ".join(f"{j} ({', '.join(sorted(c))})" for j, c in sorted(unknown.items())))
    print(f"{len(set(bad))} mismatches")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
