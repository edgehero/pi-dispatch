"""The gateway's maintained-library workbench. The layout owns views, never terminal authority."""
from pulse import *

CSS = """
[hidden] { display: none !important; }
.wb-shell { position: fixed; inset: 0; z-index: 20; height: 100dvh; display: flex; flex-direction: column; background: var(--canvas); color: var(--ink); min-width: 0; }
.wb-top { flex: none; min-height: 48px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--surface); }
.wb-top .brandpill { padding: 4px 9px 4px 4px; font-size: 13px; gap: 7px; }
.wb-top .brandpill__m { width: 25px; height: 25px; font-size: 11px; }
.wb-top h1 { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.wb-top-end { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.wb-shell .btn { min-height: 28px; font-size: 11px; padding: 5px 8px; }
.wb-main { flex: 1; display: grid; grid-template-columns: 204px minmax(0, 1fr); min-height: 0; min-width: 0; }
.wb-main.wb-rail-closed { grid-template-columns: minmax(0, 1fr); }
.wb-main.wb-rail-closed .wb-rail { display: none; }
.wb-rail { background: var(--surface); border-right: 1px solid var(--line); padding: 14px 10px 10px; display: flex; flex-direction: column; min-height: 0; overflow: auto; }
.wb-rail-title { font-size: 12px; font-weight: 650; display: flex; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
.wb-host { color: var(--ink-muted); font-family: var(--font-mono); font-size: 11px; overflow-wrap: anywhere; margin-bottom: 8px; }
.wb-terminal-list { display: grid; gap: 3px; }
.wb-terminal-row { width: 100%; min-width: 0; display: grid; gap: 4px; padding: 9px 8px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.wb-terminal-row:hover { background: var(--surface-2); }
.wb-terminal-row[aria-current="true"] { background: var(--running-tint); border-color: var(--line); }
.wb-terminal-row b { font-family: var(--font-mono); font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
.wb-terminal-row small { font-size: 10px; color: var(--ink-muted); }
.wb-rail .btn { margin-top: 12px; }
.wb-rail-note { margin-top: auto; padding-top: 20px; font-size: 11px; line-height: 17px; color: var(--ink-muted); }
.wb-stage { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--surface-2); }
.wb-controls { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 5px 8px; border-bottom: 1px solid var(--line); background: var(--surface); }
.wb-controls select { min-width: 80px; max-width: 130px; font-size: 11px; padding: 4px; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.wb-context { flex: none; min-height: 26px; padding: 5px 12px; display: flex; flex-wrap: wrap; gap: 5px 10px; align-items: center; color: var(--ink-muted); font-size: 11px; line-height: 16px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.wb-context b { color: var(--ink); font-weight: 650; }
.wb-roster { flex: none; max-height: 34vh; overflow: auto; padding: 7px 12px; background: var(--running-tint); border-bottom: 1px solid var(--line); color: var(--ink); font-size: 12px; line-height: 18px; }
.wb-roster ul { display: flex; flex-wrap: wrap; gap: 5px 18px; margin: 0; padding: 0; list-style: none; }
.wb-roster li { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.wb-roster button { border: 0; background: transparent; color: var(--focus); font: inherit; text-decoration: underline; cursor: pointer; }
.wb-roster small { display: block; color: var(--ink-muted); margin-top: 3px; }
.wb-dock { flex: 1; min-width: 0; min-height: 0; position: relative; }
.wb-empty { padding: 24px; color: var(--ink-muted); font-size: 14px; line-height: 22px; }
.wb-pane { height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--surface-2); position: relative; }
.wb-pane-head { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 5px 10px; padding: 6px 10px; font-size: 11px; line-height: 16px; border-bottom: 1px solid var(--line); color: var(--ink-muted); }
.wb-pane-head .btn { margin-left: auto; }
.wb-terminal { flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--surface-2); }
.wb-terminal .xterm { height: 100%; padding: 10px; }
.wb-terminal .xterm .xterm-viewport { background: var(--surface-2); }
.wb-pane[data-active="true"] .wb-terminal:focus-within .xterm-viewport { box-shadow: inset 0 0 0 2px var(--focus); }
.wb-terminal.wb-watch-output { overflow: auto; }
.wb-watch-output .xterm { height: auto; min-width: 100%; }
.wb-pane[data-active="true"] .wb-pane-head { background: var(--running-tint); }
.wb-watch-output:focus-visible { outline: none; }
.wb-pane[data-active="true"] .wb-watch-output:focus-within .xterm-viewport { box-shadow: none; }
.wb-pane[data-kind="watch"]:focus-within .wb-pane-head { box-shadow: inset 0 -2px 0 var(--focus); }
.wb-watch-wait { flex: none; margin: 0; padding: 8px 10px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.wb-pane-state { flex: none; padding: 18px; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.wb-pane-state h3 { color: var(--ink); font-size: 14px; margin-bottom: 6px; }
.wb-too-small { position: absolute; inset: 35px 0 0; background: var(--surface-2); padding: 18px; color: var(--ink-muted); font-size: 13px; line-height: 20px; }
.wb-pane[data-state="too-small"] .wb-terminal { visibility: hidden; }
.wb-status { flex: none; min-height: 30px; display: flex; flex-wrap: wrap; gap: 5px 14px; align-items: center; padding: 5px 12px; background: var(--surface); border-top: 1px solid var(--line); color: var(--ink-muted); font-size: 11px; line-height: 17px; }
.wb-status label { display: inline-flex; align-items: center; gap: 6px; }
.wb-status input { accent-color: var(--primary); }
.wb-status-end { margin-left: auto; }
.wb-tab { display: flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 11px; min-width: 0; }
.wb-tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-tab button { color: var(--ink-muted); background: transparent; border: 0; cursor: pointer; font-size: 16px; line-height: 20px; padding: 0 3px; }
.wb-shell button:focus-visible, .wb-shell a:focus-visible, .wb-shell select:focus-visible, .wb-terminal-row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.wb-layout { --dv-background-color: var(--surface-2); --dv-group-view-background-color: var(--surface-2); --dv-tabs-and-actions-container-background-color: var(--surface); --dv-activegroup-visiblepanel-tab-background-color: var(--surface-2); --dv-activegroup-visiblepanel-tab-color: var(--ink); --dv-activegroup-hiddenpanel-tab-background-color: var(--surface); --dv-activegroup-hiddenpanel-tab-color: var(--ink-muted); --dv-inactivegroup-visiblepanel-tab-background-color: var(--surface-2); --dv-inactivegroup-visiblepanel-tab-color: var(--ink-muted); --dv-inactivegroup-hiddenpanel-tab-background-color: var(--surface); --dv-inactivegroup-hiddenpanel-tab-color: var(--ink-muted); --dv-separator-border: var(--line); --dv-paneview-header-border-color: var(--line); --dv-active-sash-color: var(--focus); --dv-sash-color: var(--line); --dv-tab-font-size: 11px; --dv-tab-divider-color: var(--line); --dv-tabs-and-actions-container-height: 32px; --dv-icon-hover-background-color: var(--surface-3); --dv-tab-close-icon-size: 12px; --dv-drag-over-background-color: var(--running-tint); --dv-drag-over-border-color: var(--focus); --dv-border-radius: 0; }
.wb-layout .dv-tabs-and-actions-container { border-bottom: 1px solid var(--line); }
.wb-reference { position: relative; height: 900px; min-height: 900px; }
.wb-example-grid { display: grid; grid-template-columns: 3fr 2fr; grid-template-rows: 1fr 1fr; gap: 4px; height: 100%; background: var(--line); }
.wb-example-main { grid-row: 1 / 3; }
.wb-example-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--surface-2); }
.wb-example-tabs { min-height: 32px; display: flex; align-items: center; gap: 14px; background: var(--surface); border-bottom: 1px solid var(--line); padding: 5px 10px; font-family: var(--font-mono); font-size: 11px; }
.wb-example-watch-output { min-width: 1040px; min-height: 680px; }
.wb-example-output { margin: 0; padding: 10px; font-family: var(--font-mono); font-size: 13px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 1100px) { .wb-main { grid-template-columns: 174px minmax(0, 1fr); } .wb-top .chip { display: none; } }
@media (max-width: 760px) { .wb-reference { display: none; } }
@media (min-width: 761px) { .wb-reference-phone { display: none; } }
"""

def workbench():
    rows = ''.join(f'<button type="button" class="wb-terminal-row"' + (' aria-current="true"' if i == 0 else '') + f'><b>{jid}</b><small>{label}</small></button>' for i, (jid, label) in enumerate([('gh-9575', 'Connected, ops'), ('gh-4add', 'Watching, lee'), ('gh-d40e', 'Connected, ops'), ('sb-3c1f', 'Connected, ops')]))
    pi = 'pi 1.5.0, illustrative offline terminal\n\nescape interrupt · ctrl+c/ctrl+d clear/exit\n\nNo model request was submitted.\n\n/workspace\n\nInspect this repository. (Unsent draft)\n────────────────────────────────────\n0.0%/0 (auto)'
    def pane(jid, output, main=False):
        return f'<section class="wb-example-pane' + (' wb-example-main' if main else '') + '"><div class="wb-example-tabs">' + jid + (' <span>sb-3c1f</span>' if main else '') + '</div><div class="wb-pane-head">mini1 · ' + ('Watching ops, read only, 120 × 36' if jid == 'gh-4add' else 'ops · existing shell') + '</div><pre class="wb-example-output">' + E(output) + '</pre></section>'
    grid = pane('gh-9575', pi, True) + pane('gh-4add', 'pi@gh-4add:/workspace$ git status --short\n M src/routes.mjs\n\nOnly new output is shown.') + pane('gh-d40e', 'pi@gh-d40e:/workspace$ pwd\n/workspace\n\npi@gh-d40e:/workspace$ ')
    top = '<header class="wb-top"><span class="brandpill"><span class="brandpill__m">pi</span>pi-dispatch</span><h1>Sandbox workspace</h1>' + chip('mini1 · ops') + '<div class="wb-top-end">' + btn('Add existing terminal') + btn('Theme: dark', 'ghost') + btn('Back to gh-9575', 'ghost') + '</div></header>'
    toolbar = '<div class="wb-controls">' + ''.join(btn(label, 'ghost') for label in ['Terminals', 'Split right', 'Split below', 'Move left', 'Move right', 'Move to group', 'Narrower', 'Wider', 'Shorter', 'Taller', 'Combine tabs', 'Close terminal']) + '</div>'
    context = '<div class="wb-context"><b>gh-9575</b> Completed · web · acme/web#490 · fix · ended 15:12 UTC</div>'
    roster = '<section class="wb-roster"><ul><li><b>gh-9575:</b> lee is watching <button type="button">Remove lee</button></li></ul><small>Watchers see all new output, including what is typed.</small></section>'
    foot = '<footer class="wb-status"><label><input type="checkbox" checked> Tab moves focus</label><label><input type="checkbox" checked> Let operators watch</label><span class="wb-status-end">Only new output. Closing leaves the shell running.</span></footer>'
    phone = card('Use your own terminal', '<p>Browser terminals require a window wider than 760 pixels. Return to the run and copy its command.</p>', cls='wb-reference-phone')
    return '<a class="skip" href="#p-workbench">Skip to content</a><main class="wb-shell wb-reference" id="p-workbench" data-panel>' + top + '<div class="wb-main"><aside class="wb-rail"><h2 class="wb-rail-title">Open terminals <span>4</span></h2><p class="wb-host">mini1</p><nav class="wb-terminal-list" aria-label="Open terminals">' + rows + '</nav><p class="wb-rail-note">One host, separate existing shells. Four attachments maximum.</p></aside><div class="wb-stage">' + toolbar + context + roster + '<div class="wb-dock wb-example-grid">' + grid + '</div></div></div>' + foot + '</main>' + phone

def run_reference(watch=False):
    if not watch:
        return workbench().replace(' id="p-workbench" data-panel', '').replace('<div class="wb-context">', '<div class="wb-context" id="p-gateway-run" data-panel>', 1).replace('<div class="wb-dock wb-example-grid">', '<div class="wb-dock wb-example-grid" id="p-gateway-terminal" data-panel>', 1)
    head = '<header class="wb-top"><span class="brandpill"><span class="brandpill__m">pi</span>pi-dispatch</span><h1>Watching gh-9575</h1>' + chip('mini1 · lee') + '<div class="wb-top-end">' + btn('Theme: dark', 'ghost') + btn('Back to gh-9575', 'ghost') + '</div></header>'
    context = '<div class="wb-context" id="p-gateway-run" data-panel><b>gh-9575 on mini1</b> Completed · web · acme/web#490 · fix · ended 15:12 UTC</div>'
    controls = '<div class="wb-controls"><b>Read only.</b> ops is typing. Shown at the driver’s size, 120 × 36. ' + btn('Stop watching', 'ghost') + '</div>'
    output = '<div class="wb-terminal wb-watch-output"><pre class="wb-example-output wb-example-watch-output">pi@gh-9575:/workspace$ git status --short\n M src/routes.mjs\n\nOnly new output is shown. Earlier output is not replayed.</pre></div>'
    terminal = '<section class="wb-dock" id="p-gateway-watch" data-panel><div class="wb-pane">' + output + '</div></section>'
    foot = '<footer class="wb-status">Read only. Watching ends when ops disconnects, turns watching off or removes you. Nothing is recorded.</footer>'
    phone = card('Watch on a wider screen', '<p>Browser terminals require a window wider than 760 pixels. Return to the console for the native terminal route.</p>', cls='wb-reference-phone')
    return '<a class="skip" href="#main">Skip to content</a><main class="wb-shell wb-reference" id="main">' + head + '<div class="wb-main wb-rail-closed"><div class="wb-stage">' + context + controls + terminal + '</div></div>' + foot + '</main>' + phone

README = '''The separate gateway workbench, using maintained xterm and community Dockview. It fills the viewport with tabs and splits while retaining Pulse type, colour and controls.

**How a person uses it.**
- Add an existing terminal through the console chooser and fresh same-token authorization. Four drive or watch tabs share one original sign-in; additions arrive in the background.
- Select tabs or the host rail, split an existing tab right or below, move or reorder it, and resize its group. Every drag operation has a keyboard control. Moving preserves the terminal and its connection.
- Close or disconnect only the named browser attachment. The original shell keeps running. Reloading detaches all; no connection, input or earlier layout is replayed.
- Read the active terminal’s run context and use its run-specific return. Prepared shells without a record keep the generic console return.
- Let operators watch starts off for every driver. The persistent roster names watchers of every terminal, including inactive tabs, with Remove. A watcher cannot type or resize.
- Tab moves focus starts on; Ctrl+Shift+M restores it. Escape and Ctrl+C retain their shell meanings. Hidden driver tabs still answer terminal device queries, without human activity.
- Narrow desktop layouts collapse the rail and combine groups into tabs. A terminal too short for 40 by 10 cells waits for a larger pane without losing its connection. Phone layouts disconnect and retain the native copy route.

**Panels.** `p-workbench`.

**The server provides.**
- Exact session, target, owner and drive/watch identity only after admission. Public helper messages contain only a public intent id.
- Closed run facts, driver geometry and a bounded consented watcher roster. Rendering the complete roster precedes its acknowledgement.
- Bounded live terminal transport and per-pane end reasons. Terminal content is not recorded, replayed or used as instructions for a run.

**Fixture note.** mini1, ops, lee and the four named shells are illustrative. The pi text is a clearly labelled offline example, not an agent response. Static layout establishes the reference; real Dockview/xterm and live runtime/browser tests establish behavior.
'''

if __name__ == '__main__':
    write('SandboxWorkbench', card_marker('Runs', 1000, 1440, 'Existing terminals, tabs, splits and consented read-only watches'), 'Sandbox workspace', workbench(), CSS)
    open(f'{ROOT}/SandboxWorkbench/README.md', 'w').write(README)
    print('sandbox workbench card written')
