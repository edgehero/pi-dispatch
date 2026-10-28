"""Shared pieces for the calm Overview variants (fixture: Thu 2026-10-08 15:39 UTC)."""
import html
E = html.escape

def m(hhmm):
    h, mm = hhmm.split(":"); return int(h) * 60 + int(mm)
NOW = m("15:39")

S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
ICONS = {
 "home": f'<path {S} d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
 "runs": f'<path {S} d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1.2" fill="currentColor"/><circle cx="4.8" cy="12" r="1.2" fill="currentColor"/><circle cx="4.8" cy="17.5" r="1.2" fill="currentColor"/>',
 "parked": f'<path {S} d="M4 5.5h16v10.5h-8.5L7 19.5V16H4z"/><path {S} d="M10.2 8.7a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1"/><circle cx="12" cy="13.6" r=".95" fill="currentColor"/>',
 "spend": f'<path {S} d="M4 16a8 8 0 1 1 16 0"/><path {S} d="M12 16l3.5-4.5"/><circle cx="12" cy="16" r="1.4" fill="currentColor"/>',
 "fleet": f'<rect {S} x="4" y="4.5" width="16" height="6" rx="1.6"/><rect {S} x="4" y="13.5" width="16" height="6" rx="1.6"/><circle cx="7.5" cy="7.5" r="1" fill="currentColor"/><circle cx="7.5" cy="16.5" r="1" fill="currentColor"/>',
 "config": f'<path {S} d="M5 7h9M18 7h1M5 17h3M12 17h7M5 12h1M10 12h9"/><circle {S} cx="16" cy="7" r="2"/><circle {S} cx="10" cy="17" r="2"/><circle {S} cx="8" cy="12" r="2"/>',
 "audit": f'<rect {S} x="5" y="4.5" width="14" height="16" rx="2"/><path {S} d="M9 4.5V3.5h6v1M9 12l2 2 4-4"/>',
 "search": f'<circle {S} cx="11" cy="11" r="6"/><path {S} d="M20 20l-4.2-4.2"/>',
 "chev": f'<path {S} d="M7 10l5 5 5-5"/>',
 "chev-l": f'<path {S} d="M14 7l-5 5 5 5"/>',
 "chev-r": f'<path {S} d="M10 7l5 5-5 5"/>',
 "plus": f'<path {S} d="M12 5v14M5 12h14"/>',
 "minus": f'<path {S} d="M5 12h14"/>',
 "pause": '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/>',
 "play": '<path d="M8 5.5 18.5 12 8 18.5z" fill="currentColor"/>',
 "theme": f'<circle {S} cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
 "bolt": f'<path {S} d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
 "git": f'<circle {S} cx="7" cy="6" r="2"/><circle {S} cx="7" cy="18" r="2"/><circle {S} cx="17" cy="9" r="2"/><path {S} d="M7 8v8M17 11c0 3-3 4-10 5"/>',
 "clock": f'<circle {S} cx="12" cy="12" r="8"/><path {S} d="M12 7.5V12l3 2"/>',
 "terminal": f'<rect {S} x="3.5" y="5" width="17" height="14" rx="2.5"/><path {S} d="M7.5 10l2.5 2-2.5 2M12.5 15h4"/>',
 "shield": f'<path {S} d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/><path {S} d="M9 12l2.2 2.2L15.5 10"/>',
 "queue": f'<path {S} d="M12 4 20 8l-8 4-8-4z"/><path {S} d="M4 12l8 4 8-4M4 16l8 4 8-4"/>',
 "rerun": f'<path {S} d="M19 12a7 7 0 1 1-2.1-5"/><path {S} d="M19.5 4.5V8H16"/>',
 "done": f'<path {S} stroke-width="2.2" d="M5.5 12.5 10 17l8.5-9.5"/>',
 "failed": f'<path {S} stroke-width="2.2" d="M7 7l10 10M17 7 7 17"/>',
 "refused": f'<circle {S} stroke-width="2" cx="12" cy="12" r="7.5"/><path {S} stroke-width="2" d="M6.8 17.2 17.2 6.8"/>',
 "attention": f'<path {S} d="M12 4 21 19.5H3z"/><path {S} stroke-width="2" d="M12 10v4.2"/><circle cx="12" cy="16.9" r="1.1" fill="currentColor"/>',
 "running": '<circle cx="12" cy="12" r="5.5" fill="currentColor"/>',
 "hourglass": f'<path {S} d="M7 4h10M7 20h10M8 4v2.5l4 5.5-4 5.5V20M16 4v2.5L12 12l4 5.5V20"/>',
 "beat": f'<path {S} d="M3 12.5h3.5l2-5 3.5 10 2.4-6.2 1.3 1.2H21"/>',
 "doctor": f'<rect {S} x="4.5" y="4.5" width="15" height="15" rx="3"/><path {S} d="M12 8.5v7M8.5 12h7"/>',
 "cancel": '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
 "slot-held": f'<path {S} d="M8 11V8a4 4 0 0 1 8 0v3"/><rect {S} x="5.5" y="11" width="13" height="9" rx="2"/>',
 "logout": f'<path {S} d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M14 8l4 4-4 4M18 12H9"/>',
 "more": '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
 "fit": f'<path {S} d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
 "steer": f'<path {S} d="M4 12h11M11 7l5 5-5 5M20 5v14"/>',
 "info": f'<circle {S} cx="12" cy="12" r="8"/><path {S} stroke-width="2" d="M12 11v5"/><circle cx="12" cy="8" r="1.1" fill="currentColor"/>',
 "edit": f'<path {S} d="M5 19l1.2-4.2L15.5 5.5l3 3-9.3 9.3z"/><path {S} d="M13.5 7.5l3 3"/>',
 "chain": f'<path {S} d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path {S} d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
 "slot": f'<rect {S} x="4" y="7" width="16" height="10" rx="5"/><circle cx="9" cy="12" r="2" fill="currentColor"/>',
 "key": f'<circle {S} cx="8" cy="15.5" r="3.5"/><path {S} d="M10.5 13 19 4.5M15.5 8l2.5 2.5M17.5 6l2 2"/>',
 "tag": f'<path {S} d="M4 4.5h7.5l8 8-7 7L4 11z"/><circle cx="8.3" cy="8.8" r="1.3" fill="currentColor"/>',
 "comment": f'<path {S} d="M4 5.5h16v10.5h-8.5L7 19.5V16H4z"/><path {S} d="M8 9.5h8M8 12.5h5"/>',
 "pr": f'<circle {S} cx="7" cy="6" r="2"/><circle {S} cx="7" cy="18" r="2"/><circle {S} cx="17" cy="18" r="2"/><path {S} d="M7 8v8M17 16v-6a3 3 0 0 0-3-3h-3M13 4.5 10.5 7 13 9.5"/>',
 "issue": f'<circle {S} cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
 "globe": f'<circle {S} cx="12" cy="12" r="8"/><path {S} d="M4 12h16M12 4c2.4 2.3 3.5 5 3.5 8s-1.1 5.7-3.5 8c-2.4-2.3-3.5-5-3.5-8s1.1-5.7 3.5-8z"/>',
 "plug": f'<path {S} d="M9 3.5V8M15 3.5V8M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>',
 "bell": f'<path {S} d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path {S} d="M10 20.5h4"/>',
 "folder": f'<path {S} d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.5l2 2.5H19A1.5 1.5 0 0 1 20.5 9.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z"/>',
 "pie": f'<path {S} d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z"/><path {S} d="M15 3.8A8.5 8.5 0 0 1 20.2 9H15z"/>',
 "flows": f'<rect {S} x="3" y="4" width="7" height="5" rx="2.5"/><rect {S} x="14" y="15" width="7" height="5" rx="2.5"/><rect {S} x="14" y="4" width="7" height="5" rx="2"/><path {S} d="M10 6.5h4M17.5 9v6"/>',
 "skill": f'<path {S} d="M6 3.5h8l4 4v13H6z"/><path {S} d="M14 3.5v4h4M9 12.5h6M9 16h4"/>',
 "flag": f'<path {S} d="M6 21V4"/><path {S} d="M6 4h11l-2.5 4L17 12H6"/>',
 "box": f'<path {S} d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path {S} d="M4 7.5 12 12l8-4.5M12 12v9"/>',
 "eye": f'<path {S} d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle {S} cx="12" cy="12" r="3"/>',
 "layers": f'<path {S} d="M12 4 20 8.5 12 13 4 8.5z"/><path {S} d="M4 12.5 12 17l8-4.5"/><path {S} d="M4 16.5 12 21l8-4.5"/>',
}

def sprite():
    syms = "".join(f'<symbol id="i-{k}" viewBox="0 0 24 24">{v}</symbol>' for k, v in ICONS.items())
    pat = ('<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
           '<rect class="hatch-bg" width="6" height="6"/><rect class="hatch-ln" width="2" height="6"/></pattern>')
    return f'<svg class="sprite" aria-hidden="true" focusable="false"><defs>{syms}{pat}</defs></svg>'

def ic(name, cls="ic"):
    return f'<svg class="{cls}" aria-hidden="true"><use href="#i-{name}"/></svg>'

def ring(pct, tone, size=96, stroke=9, label="", hold=0.8):
    r = (size - stroke) / 2
    c = size / 2
    hold_html = ""
    if hold:
        import math
        a = -math.pi / 2 + 2 * math.pi * hold
        x1, y1 = c + (r - stroke / 2 - 1) * math.cos(a), c + (r - stroke / 2 - 1) * math.sin(a)
        x2, y2 = c + (r + stroke / 2 + 1) * math.cos(a), c + (r + stroke / 2 + 1) * math.sin(a)
        hold_html = f'<line class="ring__hold" x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"/>'
    v = max(0.5, min(100, pct * 100))
    return (f'<svg class="ring tone-{tone}" width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" aria-label="{E(label)}">'
            f'<circle class="ring__track" cx="{c}" cy="{c}" r="{r}" stroke-width="{stroke}"/>'
            f'<circle class="ring__arc" cx="{c}" cy="{c}" r="{r}" stroke-width="{stroke}" pathLength="100" stroke-dasharray="{v:.1f} 100" transform="rotate(-90 {c} {c})"/>'
            f'{hold_html}</svg>')

def pbar(pct, tone="running", label="", h=8):
    return (f'<svg class="pbar tone-{tone}" height="{h}" role="img" aria-label="{E(label)}"><rect class="pbar__bed" width="100%" height="{h}" rx="{h/2}"/>'
            f'<rect class="pbar__fill" width="{max(pct*100, 2):.1f}%" height="{h}" rx="{h/2}"/></svg>')

def doc(marker, title, style, body):
    return f"""{marker}
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)}</title>
<style>
{style}
</style>
</head>
<body>
{sprite()}
{body}
</body>
</html>
"""

PARKED_Q = "Should the export rate limit apply per API key or per account? The issue mentions both."

# Runs that ended in the last 24 hours (end, id, outcome) and the hour each falls in, oldest first
DAY = [("16:52", "gl-af91", "ok"), ("17:15", "gh-c3f8", "ok"), ("17:41", "gh-476b", "ok"), ("03:11", "nightly-tidy", "ok"),
       ("08:58", "gh-b0bd", "ok"), ("09:29", "gh-52a8", "ok"), ("09:45", "gh-444c", "ok"), ("10:43", "gh-7813", "ok"),
       ("10:44", "gl-021a", "ok"), ("10:59", "gh-4a7e", "idle"), ("11:05", "gh-985d", "ok"), ("12:23", "gh-98f4", "ok"),
       ("12:39", "gh-7cdf", "ok"), ("12:43", "gh-03a9", "ok"), ("13:49", "gl-9a2c", "ok"), ("13:55", "gh-8251-r1", "ok"),
       ("14:06", "gh-e12d", "ok"), ("14:09", "gh-bd09", "ok"), ("14:17", "gh-8251-r2", "ok"), ("14:34", "gh-a3ac", "ok"),
       ("14:39", "gh-4add", "ok"), ("14:48", "gh-ebd7", "ok"), ("15:10", "gh-f0c2", "failed"), ("15:12", "gh-9575", "ok"),
       ("15:13", "gh-2f6a", "parked"), ("15:25", "gh-a91e", "ok"), ("15:30", "gh-e9a0", "refused")]

def day_matrix(rows=5, cls="matrix"):
    """24 columns (16:00 yesterday .. 15:00 today), dots stacked bottom-up by outcome."""
    hours = list(range(16, 24)) + list(range(0, 16))
    cols = {h: [] for h in hours}
    for t, jid, oc in DAY:
        cols[int(t[:2])].append(oc)
    order = {"failed": 0, "refused": 1, "parked": 2, "idle": 3, "ok": 4}
    cells = []
    for r in range(rows - 1, -1, -1):
        for h in hours:
            v = sorted(cols[h], key=lambda x: order[x])
            v = v[::-1]
            cells.append(f'<i class="{v[r]}"></i>' if r < len(v) else "<i></i>")
    return f'<div class="{cls}" role="img" aria-label="Runs that ended in each hour of the last 24 hours: 23 completed, 1 failed, 1 refused, 1 awaiting input, 1 cancelled">{"".join(cells)}</div>'
