"""Pulse page kit: the shell every console page shares, and helpers for the shared components.
Screens import this and compose; page-specific CSS stays small and lives in the screen's own <style>."""
import os, math
from common2 import E, m, NOW, ICONS, sprite as _sprite, ic, ring, pbar, PARKED_Q

from paths import COMPONENTS
ROOT = str(COMPONENTS)
ARROW = ('<svg class="sprite" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" '
         'markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs></svg>')

def write(name, marker, title, body, style=""):
    os.makedirs(f"{ROOT}/{name}", exist_ok=True)
    html = f"""{marker}
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)}</title>
{f'<style>{style}</style>' if style.strip() else ''}
</head>
<body>
{_sprite()}
{ARROW}
{body}
</body>
</html>
"""
    open(f"{ROOT}/{name}/preview.html", "w").write(html)
    return name

def card_marker(group, height, width, subtitle):
    return f'<!-- @dsCard group="{group}" height={height} width={width} subtitle="{E(subtitle)}" -->'

# ---------------- shell ----------------
NAV = [("home", "Overview"), ("runs", "Runs"), ("parked", "Parked"), ("fleet", "Fleet"), ("spend", "Spend"), ("bolt", "Triggers"),
       ("config", "Configuration")]

def topbar(active="Overview", parked=1, role="operator", live="live"):
    items = []
    for icon, name in NAV:
        cur = ' aria-current="page"' if name == active else ""
        badge = f' <span class="count tone-parked" aria-label="{parked} waiting">{parked}</span>' if name == "Parked" and parked else ""
        items.append(f'<a href="#"{cur}>{ic(icon)}{name}{badge}</a>')
    more_cur = ' aria-current="page"' if active in ("Audit", "Models") else ""
    more_label = "More: Models" + (", Audit" if role == "operator" else "")
    items.append(f'<a href="#" class="pillnav__more"{more_cur} aria-label="{more_label}">{ic("more")}</a>')
    livepill = {"live": '<span class="live" role="status"><span class="dot"></span>Live</span>',
                "retry": '<span class="live live--retry" role="status"><span class="dot"></span>Reconnecting</span>',
                "off": '<span class="live live--off" role="status"><span class="dot"></span>Not live</span>'}[live]
    who = ("ops", "Operator") if role == "operator" else ("watcher", "Viewer")
    return f"""<header class="top">
  <a class="brandpill" href="#"><span class="brandpill__m">pi</span>pi-dispatch</a>
  <nav class="pillnav" aria-label="Console">{''.join(items)}</nav>
  <div class="top__end">
    <button class="roundbtn hide-phone" type="button" aria-label="Search runs">{ic('search')}</button>
    {livepill}
    <button class="roundbtn" type="button" aria-label="Theme: follows the system">{ic('theme')}</button>
    <span class="who"><span><b>{who[0]}</b><small>{who[1]}</small></span><span class="avatar">{who[0][:2]}</span></span>
  </div>
</header>"""

def titlebar(title, sub="", end="", back=""):
    b = f'<a class="back" href="#">{ic("chev-l", "ic ic--sm")}{E(back)}</a>' if back else ""
    return f"""<div class="titlebar">
  <div class="titlebar__lead">{b}<h1>{title}</h1>{f'<p class="titlebar__sub">{sub}</p>' if sub else ''}</div>
  {f'<div class="titlebar__end">{end}</div>' if end else ''}
</div>"""

def shell(active, inner, title, sub="", end="", back="", parked=1, role="operator", live="live", topextra=""):
    return f"""<a class="skip" href="#main">Skip to content</a>
<main id="main" class="page">
{topbar(active, parked, role, live)}
{topextra}
{titlebar(title, sub, end, back)}
{inner}
</main>"""

# ---------------- small parts ----------------
OUT = {  # outcome: (tone, glyph, word)
    "completed": ("ok", "done", "Completed"), "failed": ("failed", "failed", "Failed"), "refused": ("refused", "refused", "Refused"),
    "awaiting": ("parked", "parked", "Awaiting input"), "cancelled": ("idle", "cancel", "Cancelled"), "running": ("running", "running", "Running"),
    "held": ("idle", "clock", "Held"), "delayed": ("idle", "hourglass", "Delayed"), "approval": ("parked", "shield", "Awaiting approval"),
    "attention": ("attention", "attention", "Needs a look"), "ok": ("ok", "done", "Healthy"),
}
def badge(kind, word=None):
    tone, glyph, w = OUT[kind]
    return f'<span class="badge tone-{tone}">{ic(glyph)}{word or w}</span>'

def tag(p):
    return f'<span class="ptag">{E(p)}</span>'

def venue(v):
    return f'<span class="vtag">{E(v)}</span>'

def chip(text, tone="", icon=""):
    return f'<span class="chip{(" tone-" + tone) if tone else ""}">{ic(icon) if icon else ""}{text}</span>'

def btn(text, kind="", icon="", sm=True, href="#"):
    cls = "btn" + (" btn--sm" if sm else "") + (f" btn--{kind}" if kind else "")
    return f'<a class="{cls}" href="{href}">{ic(icon, "ic ic--sm") if icon else ""}{text}</a>'

def card(title, body, end="", sub="", cls="", id_="", flush=False):
    i = f' id="{id_}" data-panel' if id_ else ""
    return f"""<section class="card{' card--flush' if flush else ''}{(' ' + cls) if cls else ''}"{i}>
  <div class="card__head"><h2>{title}</h2>{f'<span class="card__sub">{sub}</span>' if sub else ''}{f'<span class="end">{end}</span>' if end else ''}</div>
  {body}
</section>"""

def facts(pairs, cols=2):
    cls = {1: "facts facts--1", 2: "facts", 3: "facts facts--3"}[cols]
    return f'<dl class="{cls}">' + "".join(f'<div class="fact"><dt>{k}</dt><dd>{v}</dd></div>' for k, v in pairs) + "</dl>"

def cmd(text, label="Copy"):
    return f'<div class="cmd"><code>{E(text)}</code><button class="btn btn--sm" type="button">{label}</button></div>'

def meterrow(label, sub, pct, value, cap, tone=None):
    tone = tone or ("ok" if pct < .8 else ("attention" if pct < 1 else "failed"))
    bar = (f'<svg class="pbar tone-{tone}" height="10" role="meter" aria-valuenow="{int(pct*100+.5)}" aria-valuemax="100" aria-label="{E(label)} {E(sub)}: {value} of {cap}">'
           f'<rect class="pbar__bed" width="100%" height="10" rx="5"/><rect class="pbar__fill" width="{max(min(pct,1)*100,2):.1f}%" height="10" rx="5"/>'
           f'<line class="pbar__hold" x1="80%" x2="80%" y1="-3" y2="13"/></svg>')
    return f'<div class="meterrow"><span class="meterrow__l">{E(label)}{f"<small>{E(sub)}</small>" if sub else ""}</span>{bar}<span class="meterrow__v">{value} <span>/ {cap}</span></span></div>'

def capsule(lab, per, p, H=150):
    hpx = max(30, min(p, 1) * H); hold = 0.8 * H; v = int(p * 100 + .5)
    tone = "ok" if p < .8 else ("attention" if p < 1 else "failed")
    return f"""<div class="cap" title="{E(lab)} {E(per)}: {v}%">
  <svg width="40" height="{H}" viewBox="0 0 40 {H}" role="img" aria-label="{E(lab)} {E(per)}: {v} percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="{H}"/><circle class="cap__hold" cx="20" cy="{H - hold:.0f}" r="4"/>
    <rect class="cap__pill tone-{tone}" x="4" y="{H - hpx:.0f}" width="32" height="{hpx:.0f}" rx="16"/>
    <text class="cap__v" x="20" y="{H - hpx + 21:.0f}" text-anchor="middle">{v}</text></svg>
  <p class="cap__l"><b>{E(lab)}</b>{E(per)}</p></div>"""

def phases(names, now_idx, done_items=0, total_items=0):
    out = []
    for i, n in enumerate(names):
        if i < now_idx:
            out.append(f'<li class="is-done"><span class="bar"></span><span class="name">{E(n)}</span></li>')
        elif i == now_idx:
            ticks = "".join(f'<i class="{"on" if k < done_items else ""}"></i>' for k in range(total_items))
            out.append(f'<li class="is-now"><span class="bar">{ticks}</span><span class="name">{E(n)}{f", {done_items} of {total_items}" if total_items else ""}</span></li>')
        else:
            out.append(f'<li><span class="bar"></span><span class="name">{E(n)}</span></li>')
    return f'<ol class="phases" aria-label="Phase {now_idx+1} of {len(names)}">{"".join(out)}</ol>'

def diff(title, lines):
    """lines: list of (kind, text) with kind in ctx, add, del, gap"""
    body = "".join(f'<span class="d-{k}">{E(t)}</span>' for k, t in lines)
    return f'<div class="diff"><div class="diff__h">{ic("config", "ic ic--sm")}{title}</div><div class="diff__b">{body}</div></div>'

def confirm(kind, title, items, undo, confirm_text, extra="", expires="4:52"):
    k = {"safe": ("", "btn--confirm"), "paid": (" confirm--paid", "btn--confirm-paid"), "danger": (" confirm--danger", "btn--confirm-danger")}[kind]
    lis = "".join(f"<li>{i}</li>" for i in items)
    return f"""<div class="confirm{k[0]}" role="region" aria-live="polite" aria-label="Preview">
  <p class="confirm__h">{ic({'safe': 'done', 'paid': 'spend', 'danger': 'attention'}[kind])}{title}</p>
  <ul class="confirm__list">{lis}</ul>
  {extra}
  <p class="confirm__undo">{ic('rerun', 'ic ic--sm')}Undo: <b>{undo}</b></p>
  <div class="confirm__act"><button class="btn {k[1]}" type="button">{confirm_text}</button><button class="btn btn--ghost" type="button">Cancel</button><span class="ticket">Preview expires in <b>{expires}</b></span></div>
</div>"""

def banner(tone, icon, title, sentence, act="", small=False):
    return f"""<div class="banner{' banner--sm' if small else ''} tone-{tone}" role="status">
  <span class="tile">{ic(icon)}</span>
  <div><p class="banner__t">{title}</p><p class="banner__s">{sentence}</p></div>
  {f'<div class="banner__act">{act}</div>' if act else ''}
</div>"""

def outcome(kind, word, title, nxt, actions):
    tone, glyph, _ = OUT[kind]
    return f"""<section class="outcome tone-{tone}" id="p-outcome" data-panel aria-labelledby="oc-t">
  <span class="outcome__mark">{ic(glyph)}</span>
  <div><p class="outcome__w">{word}</p><h2 id="oc-t" class="outcome__t">{title}</h2><p class="outcome__n">{nxt}</p></div>
  <div class="outcome__act">{actions}</div>
</section>"""

def tx(kind, time, body, tone="", label="", trunc=False, fork=False, forkpoint=False, extra_cls=""):
    icons = {"user": "parked", "assistant": "spend", "call": "terminal", "result": "done", "error": "failed", "compaction": "queue",
             "note": "doctor", "restart": "rerun", "skipped": "hourglass", "end": "cancel", "steer": "steer"}
    names = {"user": "user", "assistant": "assistant", "call": "tool call", "result": "tool result", "error": "tool result",
             "compaction": "compaction", "note": "note", "restart": "restart", "skipped": "skipped", "end": "end", "steer": "steer"}
    cls = {"user": "user", "assistant": "assistant", "error": "error"}.get(kind, kind)
    t = f'<span class="tx__trunc">truncated</span>' if trunc else ""
    f = f'<a class="btn btn--sm btn--ghost tx__fork" href="#">{ic("git", "ic ic--sm")}Fork from here</a>' if fork else ""
    extra_cls = (extra_cls + " tx__e--fork").strip() if fork and not forkpoint else extra_cls
    return f"""<li class="tx__e tx__e--{cls}{' tx__e--forkpoint' if forkpoint else ''}{(' ' + extra_cls) if extra_cls else ''}{(' tone-' + tone) if tone else ''}">
  <span class="tx__k">{ic(icons.get(kind, 'doctor'), 'ic ic--sm')}{names.get(kind, kind)}{(' <span class="code">' + label + '</span>') if label else ''}</span>
  <div class="tx__b">{body}{t}</div>
  <span class="tx__t">{time}</span>{f}
</li>"""

HOURLY = [0, 0, 0, 0, 0, 0, 0, 0, .10, .73, .46, .16, .95, .47, 1.57, .79]
def spend_dots(rows=7, unit=.25, data=HOURLY):
    cols = []
    for h, v in enumerate(data):
        n = round(v / unit)
        cols.append('<span class="sd__c">' + "".join(f'<i class="{"on" if r < n else ""}"></i>' for r in range(rows)) + "</span>")
    return f'<div class="sd" role="img" aria-label="Metered spend by hour today">{"".join(cols)}</div>'

def slots(seq):
    return "".join({"r": '<i class="sl sl--run"></i>', "h": '<i class="sl sl--hold"></i>', "f": '<i class="sl"></i>'}[c] for c in seq)

def hostrow(name, lamp, ven, beat, beat_tone, seq, details, pause=True):
    return f"""<li class="hostrow">
  <span class="dot tone-{lamp}"></span>
  <span class="hostrow__n"><b>{name}</b><span>{ven}</span></span>
  <span class="sls" aria-label="slots">{slots(seq)}</span>
  <span class="hostrow__beat{(' tone-' + beat_tone) if beat_tone else ''}">{ic('beat', 'ic ic--sm')}{beat}</span>
  <span class="hostrow__p">{f'<button class="btn btn--sm btn--round" type="button" aria-label="Pause {name}">' + ic('pause', 'ic ic--sm') + '</button>' if pause else ''}</span>
  <span class="hostrow__x">{details}</span>
</li>"""
