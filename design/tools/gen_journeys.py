"""Journey storyboards: the main things a person does, as a strip of numbered steps, each a thumbnail cut from the real
card it comes from. The thumbnails are cut every time this runs, by panel selector, in both themes, so a card that
changes is picked up by running this again and nothing else.

A guide card, not a console page: no top bar and no nav, and no design status ribbon of its own. Each step says the
status of the screen it comes from."""
import base64, io, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
from playwright.sync_api import sync_playwright
from pulse import ROOT, write, card_marker, ic, E
from shoot import harness

WIN = 600               # CSS pixels of a panel shown per thumbnail, so every step reads at the same scale
RATIO = 0.62            # thumbnail height for its width: the top of a long panel, or the part around its focus
DSF = 2                 # cut at twice the pixels, so a dense screen shows it sharp

# status word -> (tone, glyph)
STATUS = {"Built": ("ok", "done"), "Planned": ("running", "clock"), "Proposed": ("idle", "edit")}

# One journey is a list of steps: (card, selectors to try, focus selector or None, caption, status, issue, next)
# `next` says what moves it on: ("person" or "system" or "branch", the words).
JOURNEYS = {
    "JourneyAnswer": dict(
        title="A run asks a question",
        sub="A run stops to ask, a draft is waiting, you send it, and the run carries on.",
        steps=[
            ("OverviewScreen", ["#p-needs"], None,
             "Needs you puts the question first, with its project and how long it has waited.", "Built", "#745",
             ("person", "You open it")),
            ("ParkedAnswerer", ["#p-drafted"], None,
             "On Parked, an answer rule has drafted an answer and lists its sources.", "Proposed", "#772",
             ("person", "Read and send on the run page")),
            ("RunParked", ["#p-chat"], None,
             "The run page shows the question beside the operator's answer box; draft prefill remains proposed under #772.", "Built", "#747",
             ("person", "Preview answer")),
            ("RunParked", ["#p-chat .confirm", "#p-chat"], None,
             "The preview says what it posts, where, and what the resumed run may cost.", "Built", "#747",
             ("system", "Confirm: the worker posts it and the run resumes")),
            ("RunLive", ["#p-progress"], None,
             "The run picks up from its session and reports its phases as it goes.", "Built", "#747",
             ("system", "It is counted")),
            ("ZeroTouchScreen", ["#p-zt-handled", "#p-zt-rate"], None,
             "Zero touch counts it as a touch: a quicker one, because the draft was ready.", "Proposed", "#770",
             None),
        ]),
    "JourneyFailure": dict(
        title="A run is refused or goes wrong",
        win={0: 1000, 1: 1000},
        sub="Find out why, fix the cause, and run it again; or open what it built.",
        steps=[
            ("RunsScreen", ["#p-runs"], 'tr:has-text("gh-e9a0")',
             "Runs shows gh-e9a0 as refused, with the reason in one sentence.", "Built", "#746",
             ("person", "Open the run")),
            ("RunRefused", ["#p-outcome"], None,
             "The run page says it was refused before it started, nothing was spent, and what to do.", "Built", "#747",
             ("person", "Open Connections")),
            ("ConnectionsScreen", ["#p-egress"], 'tr:has-text("build3")',
             "Egress shows build3's proxy is missing, so every job there is refused before spend.", "Built", "#751",
             ("person", "Start the proxy and run doctor again")),
            ("RunEnded", ["#p-actions .confirm", "#p-actions"], None,
             "Re-run it. The preview shows the model, the reserve and today's cap before anything starts.", "Built", "#747",
             ("branch", "Or, when a run ran but built the wrong thing")),
            ("SandboxesScreen", ["#p-sb-run"], None,
             "Open its workspace in your own terminal: the same image and files, no credentials.", "Built", "#771",
             None),
        ]),
    "JourneySetup": dict(
        title="Set up a new deployment",
        win={4: 1000},
        sub="One command in a terminal, then everything else from the console.",
        steps=[
            ("SetupScreen", ["#p-setup-start"], None,
             "A durable host bootstrap starts the console and prints a private setup link.", "Built", "#784",
             ("system", "The console opens")),
            ("SetupScreen", ["#p-setup"], None,
             "Preview and confirm supported local steps. GitHub and unsafe host changes keep their terminal route.", "Built", "#784",
             ("person", "Add the first trigger")),
            ("TriggerEditor", ["#p-trigger-preview", "#p-trigger-add"], None,
             "The first trigger is previewed as the lines it adds to the triggers file.", "Built", "#750",
             ("system", "Confirm: the next matching event starts a run")),
            ("OverviewScreen", ["#p-active"], None,
             "The Overview shows what is running, and the slots it takes.", "Built", "#745",
             ("system", "It ends")),
            ("RunsScreen", ["#p-runs"], 'tr:has-text("gh-9575")',
             "Runs lists its result, its time and what it cost.", "Built", "#746",
             None),
        ]),
}

def cut(page, selectors, focus, win=WIN):
    """The panel's picture at one scale: its left `win` CSS pixels (all of it when narrower), RATIO tall at most,
    around `focus` when given, padded with the page's canvas to exactly win x win*RATIO so every step lines up."""
    el = None
    for sel in selectors:
        loc = page.locator(sel).first
        if loc.count():
            el = loc; break
    if el is None:
        raise SystemExit(f"none of {selectors} exists")
    box = el.bounding_box()
    x, y, w, h = box["x"], box["y"], box["width"], box["height"]
    cw, ch = min(w, win), win * RATIO
    if h > ch:
        top = y
        if focus:
            f = el.locator(focus).first
            if f.count():
                fb = f.bounding_box()
                top = min(max(fb["y"] + fb["height"] / 2 - ch / 2, y), y + h - ch)
        y, h = top, ch
    png = page.screenshot(clip={"x": x, "y": y, "width": cw, "height": h}, full_page=True)
    shot = Image.open(io.BytesIO(png)).convert("RGB")
    bg = tuple(int(v) for v in re.findall(r"\d+", page.evaluate("getComputedStyle(document.body).backgroundColor"))[:3])
    W, H = round(win * DSF), round(ch * DSF)
    im = Image.new("RGB", (W, H), bg)
    im.paste(shot, ((W - shot.width) // 2 if shot.width < W else 0, 0))
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=68, method=6)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode(), im.size

def thumbs():
    """Every step's two pictures, keyed (journey, index) -> {theme: (uri, size)}."""
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        for theme in ("light", "dark"):
            pages = {}
            for jname, j in JOURNEYS.items():
                for i, (cardname, sels, focus, *_rest) in enumerate(j["steps"]):
                    win = j.get("win", {}).get(i, WIN)
                    if cardname not in pages:
                        pg = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=DSF)
                        pg.goto(harness(ROOT_PATH / cardname / 'preview.html', theme).as_uri())
                        pg.wait_for_timeout(120)
                        pages[cardname] = pg
                    out.setdefault((jname, i), {})[theme] = cut(pages[cardname], sels, focus, win)
            for pg in pages.values():
                pg.close()
        b.close()
    return out

import pathlib
ROOT_PATH = pathlib.Path(ROOT)

NEXT_ICON = {"person": ("parked", "you"), "system": ("bolt", "pi-dispatch"), "branch": ("chain", "or")}

def step_html(jname, i, step, pics, n):
    cardname, _sels, _focus, caption, status, issue, nxt = step
    tone, glyph = STATUS[status]
    lu, (lw, lh) = pics["light"]
    du, (dw, dh) = pics["dark"]
    alt = f"Step {i + 1}, from the {cardname} card: {caption}"
    issue_txt = f" · {E(issue)}" if issue else ""
    foot = ""
    if nxt:
        who, words = nxt
        gi, label = NEXT_ICON[who]
        foot = (f'<p class="j-next j-next--{who}"><span class="j-arrow" aria-hidden="true">{ic("chev-r", "ic ic--sm")}</span>'
                f'<span class="j-next__who">{ic(gi, "ic ic--sm")}{label}</span><span class="j-next__w">{E(words)}</span></p>')
    return f"""<li class="j-step">
  <div class="j-step__h"><span class="j-n" aria-hidden="true">{i + 1}</span><span class="j-from">{E(cardname)}</span>
    <span class="j-st tone-{tone}">{ic(glyph, "ic ic--sm")}{status}{issue_txt}</span></div>
  <figure class="j-fig">
    <img class="j-img j-img--l" src="{lu}" width="{lw}" height="{lh}" alt="{E(alt)}">
    <img class="j-img j-img--d" src="{du}" width="{dw}" height="{dh}" alt="{E(alt)}">
  </figure>
  <p class="j-cap">{E(caption)}</p>
  {foot}
</li>"""

def page_html(jname, j, pics):
    steps = "".join(step_html(jname, i, s, pics[(jname, i)], len(j["steps"])) for i, s in enumerate(j["steps"]))
    legend = ("".join(f'<span class="j-st tone-{t}">{ic(g, "ic ic--sm")}{w}</span>' for w, (t, g) in STATUS.items()) +
              f'<span class="j-key">{ic("parked", "ic ic--sm")}you act</span><span class="j-key">{ic("bolt", "ic ic--sm")}pi-dispatch acts</span>')
    return f"""<main class="page j-page" id="main">
  <div class="j-head">
    <p class="j-kicker">Journey · {len(j["steps"])} steps</p>
    <h1>{E(j["title"])}</h1>
    <p class="titlebar__sub">{E(j["sub"])}</p>
    <p class="j-legend">{legend}</p>
  </div>
  <ol class="j-strip" aria-label="{E(j["title"])}, in order">{steps}</ol>
</main>"""

CSS = """
.j-page { gap: var(--space-5); }
.j-head { display: grid; gap: 8px; }
.j-head h1 { font-size: 40px; line-height: 44px; font-weight: 800; letter-spacing: -0.03em; }
.j-kicker { font-size: 12px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-muted); }
.j-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 4px; }
.j-key { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.j-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); counter-reset: step; }
.j-step { display: grid; grid-template-rows: auto auto 1fr auto; gap: 10px; min-width: 0; padding: var(--space-4); border-radius: var(--radius-lg); background: var(--surface); }
.j-step__h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.j-n { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--primary); color: var(--on-primary); font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; flex: none; }
.j-from { font-family: var(--font-mono); font-size: 12px; font-weight: 650; color: var(--ink); min-width: 0; overflow-wrap: anywhere; }
.j-st { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; padding: 3px 9px; border-radius: var(--radius-pill); border: 1.5px dashed var(--tone); background: var(--tone-tint); color: var(--tone-ink); font-size: 12px; font-weight: 700; white-space: nowrap; }
.j-legend .j-st { margin-left: 0; }
.j-st.tone-idle { color: var(--ink-muted); }
.j-fig { margin: 0; aspect-ratio: 600 / 372; border-radius: var(--radius-md); overflow: hidden; box-shadow: 0 0 0 1px var(--line); background: var(--canvas); }
.j-img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: top center; }
.j-img--d { display: none; }
:root[data-theme="dark"] .j-img--l { display: none; }
:root[data-theme="dark"] .j-img--d { display: block; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .j-img--l { display: none; }
  :root:not([data-theme="light"]) .j-img--d { display: block; }
}
.j-cap { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--ink); }
.j-next { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 10px; border-top: 1px solid var(--line); font-size: 13px; line-height: 18px; color: var(--ink-muted); }
.j-arrow { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--surface-2); color: var(--ink); flex: none; }
.j-next__who { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--ink); }
.j-next__w { flex: 1 1 160px; min-width: 0; }
.j-next--branch .j-arrow { background: var(--attention-tint); color: var(--attention-ink); }
@media (max-width: 1100px) { .j-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .j-strip { grid-template-columns: minmax(0, 1fr); }
  .j-head h1 { font-size: 30px; line-height: 34px; }
  .j-arrow { transform: rotate(90deg); }
}
"""

README = {
    "JourneyAnswer": """A guide card: what happens when a run stops to ask a question, step by step, from the Overview to Zero touch. Each step is a thumbnail of the real card it comes from, with that screen's design status.

**How a person uses it.**
- Read the six steps in order:
  1. Overview's Needs you;
  2. the Parked card with a draft ready;
  3. the run page with the answer box;
  4. the answer's preview;
  5. the run carrying on;
  6. Zero touch counting the answer.
- Under each step, the next line says who moves it on: *you* (an action on the screen), *pi-dispatch* (what the system does next), or *or* (another route).
- The ribbon on each step says whether that screen is built, planned or proposed, and its issue. Open the named card for the full screen.

**Panels.** The strip of steps (`j-strip`); there are no console panels on a guide card.

**Fixture note.** The thumbnails are cut from the named cards each time `gen_journeys.py` runs, by panel (`#p-needs`, `#p-drafted`, `#p-chat`, `#p-chat .confirm`, `#p-progress`, `#p-zt-handled`), in both themes. The steps follow gh-2f6a's question; the draft step and the live step show gh-6e1d and gh-b3d7, the runs those cards draw.""",
    "JourneyFailure": """A guide card: what a person does when a run is refused or goes wrong. Find out why, fix the cause, re-run it, or open what it built. Each step is a thumbnail of the real card it comes from, with that screen's design status.

**How a person uses it.**
- Read the five steps in order:
  1. the refused row on Runs;
  2. the run page's outcome;
  3. the egress proxy that is missing on build3, on Connections;
  4. the re-run preview;
  5. the other route: open a run's workspace in your terminal.
- Under each step, the next line says who moves it on: *you*, *pi-dispatch*, or *or* for the other route.
- The ribbon on each step says whether that screen is built, planned or proposed, and its issue.

**Panels.** The strip of steps (`j-strip`); there are no console panels on a guide card.

**Fixture note.** The thumbnails are cut from the named cards each time `gen_journeys.py` runs, by panel (`#p-runs` around gh-e9a0's row, `#p-outcome`, `#p-egress` around build3's row, `#p-actions .confirm`, `#p-sb-run`), in both themes. The refusal is gh-e9a0's; the re-run preview and the workspace are gh-9575's, the run those cards draw.""",
    "JourneySetup": """A guide card: setting up a new deployment, from the one command in a terminal to the first run on Runs. Each step is a thumbnail of the real card it comes from, with that screen's design status.

**How a person uses it.**
- Read the five steps in order:
  1. the one command;
  2. Getting ready, run from the page;
  3. the first trigger and its preview;
  4. the first run on the Overview;
  5. its result on Runs.
- Under each step, the next line says who moves it on: *you* or *pi-dispatch*.
- The ribbon on each step says whether that screen is built, planned or proposed, and its issue. Supported browser setup is built by PR #784 (#774); GitHub App creation remains open.

**Panels.** The strip of steps (`j-strip`); there are no console panels on a guide card.

**Fixture note.** The thumbnails are cut from the named cards each time `gen_journeys.py` runs, by panel (`#p-setup-start`, `#p-setup`, `#p-trigger-preview`, `#p-active`, `#p-runs` around gh-9575's row), in both themes. The first run shown is gh-9575, the run those cards draw.""",
}

SUBTITLE = {
    "JourneyAnswer": "A run asks a question: from Needs you to a draft, its preview, the run resuming, and Zero touch counting it",
    "JourneyFailure": "A run is refused or goes wrong: the reason, the fix, the re-run preview, or its workspace in your terminal",
    "JourneySetup": "Set up a deployment: one command, Getting ready from the page, the first trigger, the first run",
}

def measure(name):
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 300})
        pg.goto(harness(ROOT_PATH / name / 'preview.html', 'dark').as_uri())
        pg.wait_for_timeout(120)
        h = pg.evaluate("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)")
        b.close()
    return int((h + 9) // 10 * 10)

if __name__ == "__main__":
    pics = thumbs()
    for name, j in JOURNEYS.items():
        write(name, card_marker("Start here", 1600, 1440, SUBTITLE[name]), j["title"], page_html(name, j, pics), CSS)
        open(ROOT_PATH / name / "README.md", "w").write(README[name].strip() + "\n")
        H = measure(name)
        src = ROOT_PATH / name / "preview.html"
        src.write_text(re.sub(r"height=\d+", f"height={H}", src.read_text(), count=1))
        print(f"{name}: height {H}, {src.stat().st_size // 1024} KB")
